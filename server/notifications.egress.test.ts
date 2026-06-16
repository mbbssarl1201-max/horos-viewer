import { describe, it, expect, vi, beforeEach } from "vitest";

// Audit C2 — les endpoints notifications.notify* envoient du PHI (patientName)
// vers un destinataire LIBRE. Ils doivent respecter la même allow-list de
// domaines que sendStudyReport ET tracer l'egress dans l'audit trail.
const mocks = {
  notifyNewStudy: vi.fn(),
  notifyStatUrgent: vi.fn(),
  notifyReportFinalized: vi.fn(),
  recordAccess: vi.fn(),
};

vi.mock("./email", () => ({
  sendEmail: vi.fn(),
  getSmtpStatus: vi.fn(),
  notifyNewStudy: (...a: any[]) => mocks.notifyNewStudy(...a),
  notifyStatUrgent: (...a: any[]) => mocks.notifyStatUrgent(...a),
  notifyReportFinalized: (...a: any[]) => mocks.notifyReportFinalized(...a),
}));

vi.mock("./db", async orig => {
  const actual = await orig<any>();
  return { ...actual, recordAccess: (...a: any[]) => mocks.recordAccess(...a) };
});

// Force une allow-list non vide pour exercer la garde.
vi.mock("./_core/env", async orig => {
  const actual = await orig<any>();
  return { ENV: { ...actual.ENV, reportEmailAllowedDomains: ["hopital.ch"] } };
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function medicalCtx(): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "u-7",
      email: "tech@hopital.ch",
      name: "Tech",
      loginMethod: "manus",
      role: "radiologist" as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {}, ip: "9.9.9.9" } as any,
    res: { clearCookie: () => {} } as any,
  };
}

const newStudy = {
  recipientEmail: "x@evil.com",
  patientName: "Jean Patient",
  modality: "CT",
  studyDate: "2026-06-16",
  studyDescription: "Thorax",
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.notifyNewStudy.mockResolvedValue({ success: true });
  mocks.notifyStatUrgent.mockResolvedValue({ success: true });
  mocks.notifyReportFinalized.mockResolvedValue({ success: true });
});

describe("notifications.notify* — allow-list + audit (audit C2)", () => {
  it("refuse (FORBIDDEN) un destinataire hors allow-list et n'envoie rien", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.email.notifyNewStudy(newStudy)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.notifyNewStudy).not.toHaveBeenCalled();
  });

  it("autorise un destinataire whitelisté et trace l'egress PHI", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.email.notifyNewStudy({
      ...newStudy,
      recipientEmail: "dr@hopital.ch",
    });
    expect(res).toEqual({ success: true });
    expect(mocks.notifyNewStudy).toHaveBeenCalledTimes(1);
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        action: expect.stringMatching(/notify/i),
        detail: "dr@hopital.ch",
      })
    );
  });

  it("applique la même garde à notifyStatUrgent et notifyReportFinalized", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.email.notifyStatUrgent({
        recipientEmail: "x@evil.com",
        patientName: "P",
        modality: "CT",
        studyDate: "2026-06-16",
        studyDescription: "Crâne",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.email.notifyReportFinalized({
        recipientEmail: "x@evil.com",
        patientName: "P",
        modality: "CT",
        studyDate: "2026-06-16",
        reportAuthor: "Dr",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.notifyStatUrgent).not.toHaveBeenCalled();
    expect(mocks.notifyReportFinalized).not.toHaveBeenCalled();
  });
});
