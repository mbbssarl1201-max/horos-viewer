import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks DB / stockage / PDF / IA --------------------------------------
// On mocke la couche DB (et le stockage / la génération PDF) pour tester
// l'ENFORCEMENT des gardes médico-légales du compte-rendu au niveau procédure
// tRPC, sans dépendre d'une vraie base. La logique pure de cycle de vie
// (canSignReport / canAddAddendum / validateReportSections) reste RÉELLE — elle
// est déjà testée unitairement dans client/src/lib/reportLifecycle.test.ts ;
// ici on vérifie que les procédures l'appliquent bien.
const mocks = {
  getDb: vi.fn(),
  getReportByStudy: vi.fn(),
  getReportAddenda: vi.fn(),
  getStudyById: vi.fn(),
  recordAccess: vi.fn(),
  // utilisés seulement par le test d'intégration IDOR de runAiPreanalysis
  countRecentAccess: vi.fn(),
  listSeriesByStudy: vi.fn(),
  listPriorStudiesForStudy: vi.fn(),
};

vi.mock("./db", () => ({
  getDb: (...a: any[]) => mocks.getDb(...a),
  getReportByStudy: (...a: any[]) => mocks.getReportByStudy(...a),
  getReportAddenda: (...a: any[]) => mocks.getReportAddenda(...a),
  getStudyById: (...a: any[]) => mocks.getStudyById(...a),
  recordAccess: (...a: any[]) => mocks.recordAccess(...a),
  countRecentAccess: (...a: any[]) => mocks.countRecentAccess(...a),
  listSeriesByStudy: (...a: any[]) => mocks.listSeriesByStudy(...a),
  listPriorStudiesForStudy: (...a: any[]) =>
    mocks.listPriorStudiesForStudy(...a),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn(async (key: string) => ({ key: `${key}.x`, url: "u" })),
  storageDelete: vi.fn(),
  storageGetSignedUrl: vi.fn(),
}));

vi.mock("./report/reportPdf", () => ({
  buildReportPdf: vi.fn(() => Buffer.from("%PDF-fake")),
}));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { runAiPreanalysis } from "./report/aiPreanalysis";

// --- Faux db chaînable (drizzle-like) ------------------------------------
// Reproduit la fluent-API utilisée par les procédures :
//   db.update(t).set(v).where(c)
//   db.insert(t).values(v)
//   db.select().from(t).where(c).limit(n)  →  résout vers `selectRows`
function makeFakeDb(selectRows: any[]) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const db: any = {
    update: () => ({
      set: (v: any) => ({
        where: (_c: any) => {
          updates.push(v);
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return Promise.resolve(undefined);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows),
        }),
      }),
    }),
    __inserts: inserts,
    __updates: updates,
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

const fullSections = {
  indication: "douleur",
  technique: "TDM",
  resultats: "RAS",
  conclusion: "Pas d'anomalie",
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.getReportAddenda.mockResolvedValue([]);
  mocks.getStudyById.mockResolvedValue({ id: 100, patientName: "P" });
});

// =========================================================================
// 1) IMMUABILITÉ — upsertDraft refuse de modifier un CR déjà signé
// =========================================================================
describe("reports.upsertDraft — immuabilité après signature", () => {
  it("refuse (FORBIDDEN) la modification d'un compte-rendu signé", async () => {
    mocks.getDb.mockResolvedValue(makeFakeDb([]));
    mocks.getReportByStudy.mockResolvedValue({
      id: 5,
      studyId: 100,
      status: "signed",
      ...fullSections,
    });
    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.reports.upsertDraft({ studyId: 100, sections: fullSections })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("autorise la mise à jour d'un brouillon (draft) existant", async () => {
    const db = makeFakeDb([]);
    mocks.getDb.mockResolvedValue(db);
    mocks.getReportByStudy.mockResolvedValue({
      id: 5,
      studyId: 100,
      status: "draft",
      aiGenerated: false,
      aiModel: null,
      ...fullSections,
    });
    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.reports.upsertDraft({
      studyId: 100,
      sections: fullSections,
    });
    expect(res).toEqual({ id: 5 });
    expect(db.__updates.length).toBe(1);
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.draft", studyId: 100 })
    );
  });
});

// =========================================================================
// 2) ADDENDUM — exige un CR signé (refus sur un draft)
// =========================================================================
describe("reports.addAddendum — exige un compte-rendu signé", () => {
  it("refuse (FORBIDDEN) un addendum sur un brouillon (draft)", async () => {
    mocks.getDb.mockResolvedValue(
      makeFakeDb([{ id: 5, studyId: 100, status: "draft", ...fullSections }])
    );
    const caller = appRouter.createCaller(adminCtx());
    await expect(
      caller.reports.addAddendum({ reportId: 5, text: "correction" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepte un addendum sur un compte-rendu signé", async () => {
    const db = makeFakeDb([
      {
        id: 5,
        studyId: 100,
        status: "signed",
        signedAt: new Date(),
        aiGenerated: false,
        ...fullSections,
      },
    ]);
    mocks.getDb.mockResolvedValue(db);
    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.reports.addAddendum({
      reportId: 5,
      text: "ajout",
    });
    expect(res).toEqual({ success: true });
    // l'addendum a bien été inséré (append-only)
    expect(db.__inserts).toContainEqual(
      expect.objectContaining({ reportId: 5, text: "ajout" })
    );
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.addendum", studyId: 100 })
    );
  });
});

// =========================================================================
// 3) SIGNATURE — refuse conclusion vide ; passe draft → signed sinon
// =========================================================================
describe("reports.sign — garde de signature", () => {
  it("refuse (BAD_REQUEST) si la conclusion est vide", async () => {
    mocks.getDb.mockResolvedValue(
      makeFakeDb([
        {
          id: 5,
          studyId: 100,
          status: "draft",
          indication: "i",
          technique: "t",
          resultats: "r",
          conclusion: "   ", // vide après trim
        },
      ])
    );
    const caller = appRouter.createCaller(adminCtx());
    await expect(caller.reports.sign({ reportId: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("passe le statut draft → signed et persiste la clé PDF", async () => {
    const db = makeFakeDb([
      {
        id: 5,
        studyId: 100,
        status: "draft",
        aiGenerated: false,
        ...fullSections,
      },
    ]);
    mocks.getDb.mockResolvedValue(db);
    const caller = appRouter.createCaller(adminCtx());
    const res = await caller.reports.sign({ reportId: 5 });
    expect(res.success).toBe(true);
    expect(res.pdfStorageKey).toBeTruthy();
    // l'update a bien posé status=signed + signedBy/signedAt
    expect(db.__updates).toContainEqual(
      expect.objectContaining({ status: "signed", signedBy: 1 })
    );
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.sign", studyId: 100 })
    );
  });
});

// =========================================================================
// 4) IDOR ANTÉRIORITÉ — runAiPreanalysis refuse une antériorité d'un AUTRE patient
// =========================================================================
describe("runAiPreanalysis — anti-IDOR antériorité (intégration)", () => {
  const baseInput = {
    studyId: 100,
    keyImages: [] as any[],
    indication: "douleur",
  };
  const aiCtx = { user: { id: 1 }, req: { ip: "1.2.3.4" } } as any;

  it("FORBIDDEN si priorStudyId appartient à un patient différent", async () => {
    mocks.countRecentAccess.mockResolvedValue(0);
    mocks.listSeriesByStudy.mockResolvedValue([{ id: 10 }]);
    // étude courante : patient interne 42 ; antériorité : patient interne 99
    mocks.getStudyById.mockImplementation(async (id: number) =>
      id === 100
        ? { id: 100, patientFk: 42, patientId: "AAA" }
        : { id: 200, patientFk: 99, patientId: "BBB" }
    );
    await expect(
      runAiPreanalysis({ ...baseInput, priorStudyId: 200 }, aiCtx)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
