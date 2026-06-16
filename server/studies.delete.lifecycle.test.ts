import { describe, it, expect, vi, beforeEach } from "vitest";

// Audit C1 — la suppression d'une étude doit purger AUSSI le compte-rendu
// (reports), ses addenda (report_addenda) et le PDF nominatif dans le bucket,
// sinon du PHI clinique survit à un effacement censé être définitif (nLPD/RGPD).
const mocks = {
  getDb: vi.fn(),
  getReportByStudy: vi.fn(),
  getReportAddenda: vi.fn(),
  getStudyById: vi.fn(),
  recordAccess: vi.fn(),
  storageDelete: vi.fn(),
};

vi.mock("./db", () => ({
  getDb: (...a: any[]) => mocks.getDb(...a),
  getReportByStudy: (...a: any[]) => mocks.getReportByStudy(...a),
  getReportAddenda: (...a: any[]) => mocks.getReportAddenda(...a),
  getStudyById: (...a: any[]) => mocks.getStudyById(...a),
  recordAccess: (...a: any[]) => mocks.recordAccess(...a),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn(),
  storageDelete: (...a: any[]) => mocks.storageDelete(...a),
  storageGetSignedUrl: vi.fn(),
}));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  series,
  instances,
  annotations,
  notifications,
  albumStudies,
  studies,
  reports,
  reportAddenda,
} from "../drizzle/schema";

// Faux db : `select().from(t).where()` résout selon la table ; `delete(t).where()`
// enregistre la table supprimée pour assertion.
function makeFakeDb(rows: { seriesRows: any[]; instancesRows: any[] }) {
  const deleted: any[] = [];
  const db: any = {
    select: () => ({
      from: (table: any) => ({
        where: () => {
          if (table === series) return Promise.resolve(rows.seriesRows);
          if (table === instances) return Promise.resolve(rows.instancesRows);
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: any) => ({
      where: () => {
        deleted.push(table);
        return Promise.resolve(undefined);
      },
    }),
    __deleted: deleted,
  };
  return db;
}

function adminCtx(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "u-1",
      email: "dr@example.com",
      name: "Dr Test",
      loginMethod: "manus",
      role: "admin" as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {}, ip: "1.2.3.4" } as any,
    res: { clearCookie: () => {} } as any,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.storageDelete.mockResolvedValue(undefined);
});

describe("studies.delete — effacement complet du PHI (audit C1)", () => {
  it("supprime reports + report_addenda et purge le PDF du bucket", async () => {
    const db = makeFakeDb({
      seriesRows: [{ id: 10 }],
      instancesRows: [{ id: 100, storageKey: "dicom/s10/i100.dcm" }],
    });
    mocks.getDb.mockResolvedValue(db);
    mocks.getReportByStudy.mockResolvedValue({
      id: 5,
      studyId: 1,
      status: "signed",
      pdfStorageKey: "reports/study-1.pdf",
    });

    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.studies.delete({ id: 1 });
    expect(res).toEqual({ success: true });

    // le PDF nominatif a été retiré du bucket (en plus de l'objet DICOM)
    expect(mocks.storageDelete).toHaveBeenCalledWith("reports/study-1.pdf");
    expect(mocks.storageDelete).toHaveBeenCalledWith("dicom/s10/i100.dcm");

    // les tables CR ont bien été supprimées
    expect(db.__deleted).toContain(reportAddenda);
    expect(db.__deleted).toContain(reports);
    // et toujours les tables déjà gérées
    expect(db.__deleted).toContain(studies);
    expect(db.__deleted).toContain(series);
    expect(db.__deleted).toContain(instances);
    expect(db.__deleted).toContain(annotations);
    expect(db.__deleted).toContain(notifications);
    expect(db.__deleted).toContain(albumStudies);

    // l'effacement reste tracé
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "study.delete", studyId: 1 })
    );
  });

  it("n'appelle pas storageDelete pour le PDF si l'étude n'a pas de CR", async () => {
    const db = makeFakeDb({ seriesRows: [], instancesRows: [] });
    mocks.getDb.mockResolvedValue(db);
    mocks.getReportByStudy.mockResolvedValue(undefined);

    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.studies.delete({ id: 2 });
    expect(res).toEqual({ success: true });

    // pas de CR → pas de purge PDF, mais la suppression de l'étude a lieu
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(db.__deleted).toContain(studies);
  });

  it("ne bloque pas la suppression si la purge du PDF échoue (best-effort)", async () => {
    const db = makeFakeDb({ seriesRows: [], instancesRows: [] });
    mocks.getDb.mockResolvedValue(db);
    mocks.getReportByStudy.mockResolvedValue({
      id: 6,
      studyId: 3,
      status: "signed",
      pdfStorageKey: "reports/study-3.pdf",
    });
    mocks.storageDelete.mockRejectedValue(new Error("S3 down"));

    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.studies.delete({ id: 3 });
    expect(res).toEqual({ success: true });
    // la base est tout de même purgée (l'étude disparaît de l'app)
    expect(db.__deleted).toContain(reports);
    expect(db.__deleted).toContain(studies);
  });
});
