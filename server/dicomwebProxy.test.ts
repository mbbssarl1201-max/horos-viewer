import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidDicomUid } from "./dicomwebProxy";

describe("isValidDicomUid", () => {
  it("accepte un UID DICOM valide", () => {
    expect(isValidDicomUid("1.3.6.1.4.1.14519.5.2.1.7009.2403.3342")).toBe(
      true
    );
  });
  it("rejette les caractères de path traversal", () => {
    expect(isValidDicomUid("../../etc/passwd")).toBe(false);
    expect(isValidDicomUid("1.2.3/4")).toBe(false);
    expect(isValidDicomUid("1.2.3 4")).toBe(false);
  });
  it("rejette le vide et les UID trop longs (>64)", () => {
    expect(isValidDicomUid("")).toBe(false);
    expect(isValidDicomUid("1".repeat(65))).toBe(false);
  });
});

vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: vi.fn() },
}));
vi.mock("./rbac", () => ({
  hasMedicalAccess: vi.fn(),
}));
vi.mock("./orthanc", () => ({
  orthancFetch: vi.fn(),
}));
vi.mock("./db", () => ({
  recordAccess: vi.fn(),
}));

import { handleDicomwebRequest } from "./dicomwebProxy";
import { sdk } from "./_core/sdk";
import { hasMedicalAccess } from "./rbac";
import { orthancFetch } from "./orthanc";
import { recordAccess } from "./db";

function mockRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    end(b?: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe("handleDicomwebRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 sans session", async () => {
    (sdk.authenticateRequest as any).mockRejectedValue(new Error("no session"));
    const res = mockRes();
    await handleDicomwebRequest(
      { params: { 0: "studies/1.2/series/3.4/metadata" }, headers: {} } as any,
      res as any
    );
    expect(res.statusCode).toBe(401);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("403 sans rôle médical", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({ id: 7, role: "user" });
    (hasMedicalAccess as any).mockReturnValue(false);
    const res = mockRes();
    await handleDicomwebRequest(
      { params: { 0: "studies/1.2/series/3.4/metadata" }, headers: {} } as any,
      res as any
    );
    expect(res.statusCode).toBe(403);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("400 si un UID du chemin est invalide", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({
      id: 7,
      role: "radiologist",
    });
    (hasMedicalAccess as any).mockReturnValue(true);
    const res = mockRes();
    await handleDicomwebRequest(
      {
        params: { 0: "studies/..%2F/series/3.4/metadata" },
        headers: {},
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(400);
    expect(orthancFetch).not.toHaveBeenCalled();
  });

  it("relaie la metadata et journalise l'accès une fois", async () => {
    (sdk.authenticateRequest as any).mockResolvedValue({
      id: 7,
      role: "radiologist",
    });
    (hasMedicalAccess as any).mockReturnValue(true);
    (orthancFetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/dicom+json"]]),
      arrayBuffer: async () => new TextEncoder().encode("[]").buffer,
    });
    const res = mockRes();
    await handleDicomwebRequest(
      {
        params: { 0: "studies/1.2.3/series/4.5.6/metadata" },
        headers: { accept: "application/dicom+json" },
      } as any,
      res as any
    );
    expect(orthancFetch).toHaveBeenCalledWith(
      "/dicom-web/studies/1.2.3/series/4.5.6/metadata",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/dicom+json" }),
      })
    );
    expect(res.headers["Content-Type"]).toBe("application/dicom+json");
    expect(recordAccess).toHaveBeenCalledTimes(1);
    expect((recordAccess as any).mock.calls[0][0]).toMatchObject({
      userId: 7,
      action: "mpr_volume_view",
      detail: "study=1.2.3",
    });
  });
});
