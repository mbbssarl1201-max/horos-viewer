import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Some procedures (anonymize, dicomSeries) require a live database connection
// and throw INTERNAL_SERVER_ERROR when it is absent (no silent degradation).
// Those assertions only run when a DATABASE_URL is configured.
const hasDb = !!process.env.DATABASE_URL;

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

function createUserContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@example.com",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("export.dicomSeries", () => {
  it.skipIf(!hasDb)("returns empty array for non-existent study", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.export.dicomSeries({ studyId: 99999 });
    expect(result).toEqual([]);
  });

  it("rejects regular users without a clinical role (PHI protection)", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.export.dicomSeries({ studyId: 99999 })).rejects.toThrow(
      "Clinical role required",
    );
  });
});

describe("export.pdfReport", () => {
  it("throws NOT_FOUND for non-existent study", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.export.pdfReport({ studyId: 99999 })).rejects.toThrow();
  });
});

describe("studies.anonymize", () => {
  it("requires admin role - rejects regular user", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.studies.anonymize({ id: 1, fields: ["patientName"] })
    ).rejects.toThrow("Admin or radiologist access required");
  });

  it.skipIf(!hasDb)("throws NOT_FOUND when anonymizing patient fields of a missing study", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    // Patient-identity fields require resolving the linked patient row; a
    // missing study must error rather than falsely report success.
    await expect(
      caller.studies.anonymize({ id: 99999, fields: ["patientName", "patientId"] })
    ).rejects.toThrow();
  });

  it.skipIf(!hasDb)("is a no-op for unknown fields (no study/patient touched)", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    // Unknown fields map to no column on either table → nothing to resolve,
    // so it succeeds without touching the DB.
    const result = await caller.studies.anonymize({ id: 99999, fields: ["unknownField"] });
    expect(result.success).toBe(true);
    expect(result.fieldsAnonymized).toBe(0);
  });
});

describe("notifications.list", () => {
  it("returns empty array for user with no notifications", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.notifications.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("annotations.listByInstance", () => {
  it("returns empty array for non-existent instance (clinical role)", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.annotations.listByInstance({ instanceId: 99999 });
    expect(result).toEqual([]);
  });

  it("rejects regular users without a clinical role", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.annotations.listByInstance({ instanceId: 99999 }),
    ).rejects.toThrow("Clinical role required");
  });
});
