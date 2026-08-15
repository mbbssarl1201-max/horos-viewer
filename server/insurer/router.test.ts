import { describe, it, expect, vi, beforeEach } from "vitest";

// On mocke `../db` (getDb + recordAccess, résolu depuis server/db.ts, même
// module que celui importé par server/routers.ts en "./db") et
// `./packageAndSend` (envoyerReponse + buildMailReponse, Task 6/8) — pattern
// repris de server/reports.lifecycle.test.ts (fake db chaînable + createCaller)
// et server/insurer/packageAndSend.test.ts (mock de `eq`/`desc` pour lire les
// filtres passés aux requêtes drizzle).
import {
  insurerRequests,
  insurerBundleTokens,
  studies,
} from "../../drizzle/schema";

const mocks = {
  recordAccess: vi.fn(),
  envoyerReponse: vi.fn(),
  buildMailReponse: vi.fn(),
  traiterDemande: vi.fn(),
};

let fauxRequests: any[] = [];
let fauxTokens: any[] = [];
let dernierEq: { column: unknown; value: unknown } | null = null;

function fakeDb() {
  let currentTable: unknown = null;

  const builder: any = {
    from: (table: unknown) => {
      currentTable = table;
      dernierEq = null; // nouvelle requête : pas de filtre tant que .where() n'est pas rappelé
      return builder;
    },
    where: (_c: unknown) => {
      // La requête « verdict » de insurer.list (études référencées) se termine
      // sur .where sans .limit : on la résout directement (aucune étude connue
      // dans ce fake ⇒ verdict « preparation », sans incidence sur les
      // assertions existantes).
      if (currentTable === studies) return Promise.resolve([]);
      return builder;
    },
    orderBy: (_c: unknown) => builder,
    limit: (_n: unknown) => {
      if (currentTable === insurerRequests) {
        if (dernierEq?.column === insurerRequests.id) {
          return Promise.resolve(
            fauxRequests.filter(r => r.id === dernierEq!.value)
          );
        }
        if (dernierEq?.column === insurerRequests.statut) {
          return Promise.resolve(
            fauxRequests.filter(r => r.statut === dernierEq!.value)
          );
        }
        return Promise.resolve(fauxRequests);
      }
      if (currentTable === insurerBundleTokens) {
        if (dernierEq?.column === insurerBundleTokens.requestId) {
          return Promise.resolve(
            fauxTokens.filter(t => t.requestId === dernierEq!.value)
          );
        }
        return Promise.resolve(fauxTokens);
      }
      return Promise.resolve([]);
    },
  };

  return {
    select: () => builder,
    update: (table: unknown) => ({
      set: (v: any) => ({
        where: (_c: unknown) => {
          if (table === insurerRequests) {
            const row = fauxRequests.find(r => r.id === dernierEq?.value);
            if (row) Object.assign(row, v);
          } else if (table === insurerBundleTokens) {
            fauxTokens
              .filter(t => t.requestId === dernierEq?.value)
              .forEach(t => Object.assign(t, v));
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

vi.mock("../db", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    getDb: () => Promise.resolve(fakeDb()),
    recordAccess: (...a: any[]) => mocks.recordAccess(...a),
  };
});

vi.mock("./packageAndSend", () => ({
  envoyerReponse: (...a: any[]) => mocks.envoyerReponse(...a),
  buildMailReponse: (...a: any[]) => mocks.buildMailReponse(...a),
}));

vi.mock("./mailPoller", () => ({
  traiterDemande: (...a: any[]) => mocks.traiterDemande(...a),
}));

vi.mock("drizzle-orm", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => {
      dernierEq = { column, value };
      return { __mock: "eq" };
    },
    desc: (column: unknown) => ({ __mock: "desc", column }),
  };
});

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

function ctxWithRole(role: string): TrpcContext {
  return {
    user: {
      id: 7,
      openId: "u-7",
      email: "dr@example.com",
      name: "Dr Test",
      loginMethod: "manus",
      role: role as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {}, ip: "9.9.9.9" } as any,
    res: { clearCookie: () => {} } as any,
  };
}

function medicalCtx(): TrpcContext {
  return ctxWithRole("admin");
}

function fauxRequest(overrides: Partial<any> = {}) {
  return {
    id: 1,
    messageId: "m1",
    expediteur: "assurance@suva.ch",
    sujet: "Demande",
    recuLe: new Date("2026-08-01"),
    statut: "a_valider",
    extraction: {
      patient: { nom: "Dupont", prenom: "Jean", ddn: "01.01.1980", tel: null },
      exams: [],
      refSinistre: "SIN-1",
      adresseReponse: "reponse@suva.ch",
      confiance: 0.9,
    },
    patientId: 5,
    studyIds: [10],
    adresseReponse: "reponse@suva.ch",
    motifValidation: null,
    envoyeLe: null,
    envoyePar: null,
    erreur: null,
    ...overrides,
  };
}

beforeEach(() => {
  fauxRequests = [fauxRequest()];
  fauxTokens = [
    {
      id: 1,
      requestId: 1,
      tokenHash: "secret-hash-should-never-leak",
      bundleKey: "insurer/1/bundle.zip",
      expireLe: new Date("2026-08-15"),
      telechargements: [{ ts: "2026-08-02T00:00:00Z", ip: "1.2.3.4" }],
      revoqueLe: null,
      createdAt: new Date("2026-08-01"),
    },
  ];
  dernierEq = null;
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.envoyerReponse.mockResolvedValue({ success: true });
  mocks.buildMailReponse.mockReturnValue({
    subject: "[MediView] Réponse à votre demande d'imagerie",
    html: "<p>aperçu</p>",
  });
});

describe("insurer.approve", () => {
  it("refuse (TRPCError) sur statut 'envoyee'", async () => {
    fauxRequests[0].statut = "envoyee";
    const caller = appRouter.createCaller(medicalCtx());
    await expect(caller.insurer.approve({ id: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
  });

  it("nominal (statut a_valider) : appelle envoyerReponse avec le userId du contexte", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.approve({ id: 1 });
    expect(res).toEqual({ success: true });
    expect(mocks.envoyerReponse).toHaveBeenCalledWith(1, {
      valideParUserId: 7,
    });
  });

  it("refuse si la demande n'existe pas (NOT_FOUND)", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(caller.insurer.approve({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("sélection d'études : un id HORS de la demande ⇒ BAD_REQUEST, rien n'est envoyé", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.insurer.approve({ id: 1, studyIds: [10, 999] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
  });

  it("sélection d'études : sous-ensemble valide ⇒ persisté avant l'envoi", async () => {
    fauxRequests[0].studyIds = [10, 11, 12];
    mocks.envoyerReponse.mockResolvedValue({ success: true });
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.approve({ id: 1, studyIds: [11] });
    expect(res).toEqual({ success: true });
    // Le colis (envoyerReponse → row.studyIds) ne contiendra QUE la sélection.
    expect(fauxRequests[0].studyIds).toEqual([11]);
  });

  it("refuse un utilisateur non médical (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(ctxWithRole("user"));
    await expect(caller.insurer.approve({ id: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
  });
});

describe("insurer.reject", () => {
  it("persiste le motif (préfixé) et passe le statut à 'rejetee'", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.reject({ id: 1, motif: "hors périmètre" });
    expect(res).toEqual({ ok: true });
    expect(fauxRequests[0].statut).toBe("rejetee");
    expect(fauxRequests[0].motifValidation).toBe("REJET: hors périmètre");
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, action: "insurer.reject" })
    );
  });

  it("refuse si la demande n'existe pas (NOT_FOUND)", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.insurer.reject({ id: 999, motif: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuse (BAD_REQUEST) sur statut 'envoyee' — le PHI est déjà parti", async () => {
    fauxRequests[0].statut = "envoyee";
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.insurer.reject({ id: 1, motif: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fauxRequests[0].statut).toBe("envoyee");
  });

  it("refuse (BAD_REQUEST) sur statut 'rejetee' — déjà rejetée (idempotence)", async () => {
    fauxRequests[0].statut = "rejetee";
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.insurer.reject({ id: 1, motif: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("nominal (statut a_valider) : toujours accepté", async () => {
    fauxRequests[0].statut = "a_valider";
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.reject({ id: 1, motif: "hors périmètre" });
    expect(res).toEqual({ ok: true });
    expect(fauxRequests[0].statut).toBe("rejetee");
  });
});

describe("insurer.reprocess", () => {
  it("re-traite une demande non terminale (appelle traiterDemande + audit)", async () => {
    fauxRequests[0].statut = "a_valider";
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.reprocess({ id: 1 });
    expect(res).toEqual({ ok: true });
    expect(mocks.traiterDemande).toHaveBeenCalledWith(1);
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, action: "insurer.reprocess" })
    );
  });

  it("refuse NOT_FOUND si la demande n'existe pas", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(caller.insurer.reprocess({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mocks.traiterDemande).not.toHaveBeenCalled();
  });

  it("refuse (BAD_REQUEST) sur statut 'envoyee' — demande terminée", async () => {
    fauxRequests[0].statut = "envoyee";
    const caller = appRouter.createCaller(medicalCtx());
    await expect(caller.insurer.reprocess({ id: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.traiterDemande).not.toHaveBeenCalled();
  });
});

describe("insurer.revokeToken", () => {
  it("met à jour revoqueLe sur les jetons de la demande", async () => {
    expect(fauxTokens[0].revoqueLe).toBeNull();
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.revokeToken({ requestId: 1 });
    expect(res).toEqual({ ok: true });
    expect(fauxTokens[0].revoqueLe).toBeInstanceOf(Date);
  });

  it("refuse si la demande n'existe pas (NOT_FOUND)", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(
      caller.insurer.revokeToken({ requestId: 999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("insurer.list", () => {
  it("liste triée sans filtre", async () => {
    fauxRequests.push(fauxRequest({ id: 2, statut: "envoyee" }));
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.list({});
    expect(res.items.map((r: any) => r.id).sort()).toEqual([1, 2]);
  });

  it("filtre par statut", async () => {
    fauxRequests.push(fauxRequest({ id: 2, statut: "envoyee" }));
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.list({ statut: "envoyee" });
    expect(res.items.map((r: any) => r.id)).toEqual([2]);
  });
});

describe("insurer.detail", () => {
  it("renvoie la ligne complète, les jetons SANS tokenHash, et l'aperçu du mail", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    const res = await caller.insurer.detail({ id: 1 });
    expect(res.request.id).toBe(1);
    expect(res.tokens).toEqual([
      expect.objectContaining({
        id: 1,
        expireLe: fauxTokens[0].expireLe,
        revoqueLe: null,
        telechargements: 1,
      }),
    ]);
    expect((res.tokens[0] as any).tokenHash).toBeUndefined();
    expect(mocks.buildMailReponse).toHaveBeenCalledWith(
      expect.objectContaining({ inclureCrEnPJ: false })
    );
    expect(res.mailPreview.html).toBe("<p>aperçu</p>");
  });

  it("refuse si la demande n'existe pas (NOT_FOUND)", async () => {
    const caller = appRouter.createCaller(medicalCtx());
    await expect(caller.insurer.detail({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
