import { beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

// Le mot de passe actuel « vrai » du compte de test. Le hash bcrypt est calculé
// une fois dans beforeEach pour rester réaliste (verifyPassword réel).
const CURRENT_PASSWORD = "ancien-mot-de-passe-solide";
const NEW_PASSWORD = "nouveau-mot-de-passe-solide";

const updateUserPassword = vi.fn(async () => {});
const bumpSessionVersion = vi.fn(async () => {});
let storedHash = "";

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getUserByOpenId: vi.fn(async (openId: string) => ({
      id: 1,
      openId,
      email: "gerant@example.com",
      name: "Gérant",
      loginMethod: "local",
      role: "admin",
      passwordHash: storedHash,
      sessionVersion: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    })),
    updateUserPassword,
    bumpSessionVersion,
  };
});

vi.mock("./_core/sdk", () => ({
  sdk: {
    createSessionToken: vi.fn(async () => "fresh-session-token"),
  },
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): {
  ctx: TrpcContext;
  setCookies: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }>;
} {
  const setCookies: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }> = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "gerant-open-id",
    email: "gerant@example.com",
    name: "Gérant",
    loginMethod: "local",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      cookie: (
        name: string,
        value: string,
        options: Record<string, unknown>
      ) => {
        setCookies.push({ name, value, options });
      },
    } as unknown as TrpcContext["res"],
  };

  return { ctx, setCookies };
}

describe("auth.changePassword", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { hashPassword } = await import("./localAuth");
    storedHash = await hashPassword(CURRENT_PASSWORD);
  });

  it("rejette un mot de passe actuel incorrect (UNAUTHORIZED, message générique)", async () => {
    const { appRouter } = await import("./routers");
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.auth.changePassword({
        currentPassword: "mauvais-mot-de-passe",
        newPassword: NEW_PASSWORD,
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(updateUserPassword).not.toHaveBeenCalled();
    expect(bumpSessionVersion).not.toHaveBeenCalled();
  });

  it("rejette un nouveau mot de passe identique à l'actuel (BAD_REQUEST)", async () => {
    const { appRouter } = await import("./routers");
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.auth.changePassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: CURRENT_PASSWORD,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateUserPassword).not.toHaveBeenCalled();
  });

  it("rejette un nouveau mot de passe trop court (zod, < 12 caractères)", async () => {
    const { appRouter } = await import("./routers");
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.auth.changePassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: "court",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateUserPassword).not.toHaveBeenCalled();
  });

  it("succès : hash mis à jour, sessions révoquées, cookie ré-émis", async () => {
    const { appRouter } = await import("./routers");
    const { verifyPassword } = await import("./localAuth");
    const { ctx, setCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.changePassword({
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(result).toEqual({ success: true });

    // Le hash stocké correspond au NOUVEAU mot de passe (bcrypt réel).
    expect(updateUserPassword).toHaveBeenCalledTimes(1);
    const [openId, newHash] = updateUserPassword.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(openId).toBe("gerant-open-id");
    await expect(verifyPassword(NEW_PASSWORD, newHash)).resolves.toBe(true);
    await expect(verifyPassword(CURRENT_PASSWORD, newHash)).resolves.toBe(
      false
    );

    // Toutes les autres sessions sont révoquées…
    expect(bumpSessionVersion).toHaveBeenCalledWith("gerant-open-id");

    // …mais la session courante est ré-émise (cookie frais APRÈS le bump).
    const bumpOrder = bumpSessionVersion.mock.invocationCallOrder[0] ?? 0;
    const { sdk } = await import("./_core/sdk");
    const tokenMock = vi.mocked(sdk.createSessionToken);
    const tokenOrder = tokenMock.mock.invocationCallOrder[0] ?? 0;
    expect(tokenOrder).toBeGreaterThan(bumpOrder);

    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]?.name).toBe(COOKIE_NAME);
    expect(setCookies[0]?.value).toBe("fresh-session-token");
    expect(setCookies[0]?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
