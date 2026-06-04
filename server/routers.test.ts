import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createMockContext(role: string = "admin"): { ctx: TrpcContext; clearedCookies: any[] } {
  const clearedCookies: any[] = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user-123",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: role as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

function createUnauthenticatedContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("auth.me", () => {
  it("returns null for unauthenticated user", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("returns user data for authenticated user", async () => {
    const { ctx } = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeDefined();
    expect(result?.openId).toBe("test-user-123");
    expect(result?.name).toBe("Test User");
    expect(result?.role).toBe("admin");
  });
});

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({ maxAge: -1 });
  });
});

describe("studies.list", () => {
  it("throws UNAUTHORIZED for unauthenticated user", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.studies.list()).rejects.toThrow();
  });

  it("returns empty array when no studies exist", async () => {
    const { ctx } = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.studies.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("rejects FORBIDDEN for default 'user' role (PHI protection)", async () => {
    const { ctx } = createMockContext("user");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.studies.list()).rejects.toThrow("Clinical role required");
  });

  it("allows radiologist role to list studies", async () => {
    const { ctx } = createMockContext("radiologist");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.studies.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("notifications.list", () => {
  it("throws UNAUTHORIZED for unauthenticated user", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(caller.notifications.list()).rejects.toThrow();
  });

  it("returns empty array for authenticated user with no notifications", async () => {
    const { ctx } = createMockContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.notifications.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("studies.updateStatus - RBAC", () => {
  it("throws FORBIDDEN for regular user role", async () => {
    const { ctx } = createMockContext("user");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.studies.updateStatus({ id: 1, status: "in_progress" })
    ).rejects.toThrow();
  });

  it("allows admin role to update status", async () => {
    const { ctx } = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);
    // This will fail with DB error but should not throw FORBIDDEN
    try {
      await caller.studies.updateStatus({ id: 999, status: "in_progress" });
    } catch (e: any) {
      // Should not be a FORBIDDEN error
      expect(e.code).not.toBe("FORBIDDEN");
    }
  });

  it("allows radiologist role to update status", async () => {
    const { ctx } = createMockContext("radiologist");
    const caller = appRouter.createCaller(ctx);
    try {
      await caller.studies.updateStatus({ id: 999, status: "reported" });
    } catch (e: any) {
      expect(e.code).not.toBe("FORBIDDEN");
    }
  });
});

describe("studies.delete - RBAC", () => {
  it("rejects radiologist (admin-only destructive action)", async () => {
    const { ctx } = createMockContext("radiologist");
    const caller = appRouter.createCaller(ctx);
    await expect(caller.studies.delete({ id: 1 })).rejects.toThrow(
      "Administrator access required",
    );
  });

  it("allows admin (does not throw FORBIDDEN)", async () => {
    const { ctx } = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);
    try {
      await caller.studies.delete({ id: 999 });
    } catch (e: any) {
      expect(e.code).not.toBe("FORBIDDEN");
    }
  });
});

describe("annotations.save - RBAC", () => {
  it("throws UNAUTHORIZED for unauthenticated user", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.annotations.save({
        instanceId: 1,
        type: "length",
        data: { start: [0, 0], end: [100, 100] },
      })
    ).rejects.toThrow();
  });
});

describe("auth.register / auth.login - input validation", () => {
  it("rejects registration with an invalid email", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.register({ email: "not-an-email", password: "longenough1" })
    ).rejects.toThrow();
  });

  it("rejects registration with a too-short password", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.register({ email: "a@b.com", password: "short" })
    ).rejects.toThrow();
  });

  it("rejects login with an invalid email", async () => {
    const ctx = createUnauthenticatedContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.auth.login({ email: "nope", password: "x" })
    ).rejects.toThrow();
  });
});

describe("orthanc.cFind - AE Title validation (SSRF guard)", () => {
  it("rejects an AE Title containing path separators", async () => {
    const { ctx } = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);
    // Path-traversal payload must be rejected by zod before reaching Orthanc.
    await expect(
      caller.orthanc.cFind({ aet: "../system", level: "Study", query: {} })
    ).rejects.toThrow();
  });

  it("rejects an over-long AE Title", async () => {
    const { ctx } = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.orthanc.cFind({ aet: "A".repeat(17), level: "Study", query: {} })
    ).rejects.toThrow();
  });
});
