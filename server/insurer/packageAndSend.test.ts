import { describe, it, expect, vi, beforeEach } from "vitest";

// `decideEnvoiAuto` est testée SANS mock (fonction pure, aucune dépendance).
// `envoyerReponse` est testée avec `../db`, `./bundle`, `../email` mockés
// (pattern repris de server/insurer/bundle.test.ts et matchPatient.test.ts) ;
// `../_core/env` est mocké pour forcer une allow-list non vide et exercer la
// garde egress PHI (pattern repris de server/notifications.egress.test.ts).

const mocks = {
  construireColis: vi.fn(),
  creerJeton: vi.fn(),
  sendEmail: vi.fn(),
  getStudyById: vi.fn(),
  recordAccess: vi.fn(),
};

let fauxRequests: {
  id: number;
  expediteur: string;
  extraction: unknown;
  patientId: number | null;
  studyIds: number[] | null;
  adresseReponse: string | null;
  statut: string;
  envoyeLe: Date | null;
  envoyePar: number | null;
  erreur: string | null;
}[] = [];

let dernierEq: { value: unknown } | null = null;

// Simule une base indisponible pour les `update` (transition post-envoi, ou
// écriture du motif d'erreur) — exercé par le test "db.update lève après
// l'envoi" ci-dessous.
let updateDoitEchouer = false;

function fakeDb() {
  return {
    select: () => ({
      from: (_table: any) => ({
        where: (_c: any) => ({
          limit: (_n: any) => {
            const id = dernierEq?.value;
            return Promise.resolve(fauxRequests.filter(r => r.id === id));
          },
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (v: any) => ({
        where: (_c: any) => {
          if (updateDoitEchouer) {
            return Promise.reject(
              new Error("DB update indisponible (simulation)")
            );
          }
          const id = dernierEq?.value;
          const row = fauxRequests.find(r => r.id === id);
          if (row) Object.assign(row, v);
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
    getStudyById: (...a: any[]) => mocks.getStudyById(...a),
    recordAccess: (...a: any[]) => mocks.recordAccess(...a),
  };
});

vi.mock("./bundle", () => ({
  construireColis: (...a: any[]) => mocks.construireColis(...a),
  creerJeton: (...a: any[]) => mocks.creerJeton(...a),
}));

vi.mock("../email", () => ({
  sendEmail: (...a: any[]) => mocks.sendEmail(...a),
}));

// Force une allow-list non vide pour exercer la garde egress (cf.
// server/notifications.egress.test.ts).
vi.mock("../_core/env", async orig => {
  const actual = await orig<any>();
  return { ENV: { ...actual.ENV, reportEmailAllowedDomains: ["suva.ch"] } };
});

vi.mock("drizzle-orm", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    eq: (_column: any, value: unknown) => {
      dernierEq = { value };
      return { __mock: "eq" };
    },
  };
});

import { decideEnvoiAuto, envoyerReponse } from "./packageAndSend";

const ENV_AUTO = {
  trustedSenders: ["assurance@suva.ch"],
  autoSendDomains: ["suva.ch"],
};

const ARGS_NOMINAL = {
  expediteur: "assurance@suva.ch",
  matchPatientStatut: "exact" as const,
  tousTrouves: true,
  datesExactes: true,
  adresseReponse: "reponse@suva.ch",
  env: ENV_AUTO,
};

describe("decideEnvoiAuto (fonction pure, sans mock)", () => {
  it("les 4 conditions réunies ⇒ auto:true, aucun motif", () => {
    const r = decideEnvoiAuto(ARGS_NOMINAL);
    expect(r).toEqual({ auto: true, motifs: [] });
  });

  it("expéditeur inconnu ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({
      ...ARGS_NOMINAL,
      expediteur: "inconnu@example.com",
    });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /confiance/i.test(m))).toBe(true);
  });

  it("match patient 'ambigu' ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({
      ...ARGS_NOMINAL,
      matchPatientStatut: "ambigu",
    });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /ambigu/i.test(m))).toBe(true);
  });

  it("match patient 'aucun' ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({
      ...ARGS_NOMINAL,
      matchPatientStatut: "aucun",
    });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /identifié/i.test(m))).toBe(true);
  });

  it("étude manquante (tousTrouves:false) ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({ ...ARGS_NOMINAL, tousTrouves: false });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /examen/i.test(m))).toBe(true);
  });

  it("dates approchées (datesExactes:false) ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({ ...ARGS_NOMINAL, datesExactes: false });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /date/i.test(m))).toBe(true);
  });

  it("adresseReponse domaine hors liste ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({
      ...ARGS_NOMINAL,
      adresseReponse: "reponse@autre-domaine.ch",
    });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /domaine/i.test(m))).toBe(true);
  });

  it("adresseReponse null ⇒ auto:false + motif", () => {
    const r = decideEnvoiAuto({ ...ARGS_NOMINAL, adresseReponse: null });
    expect(r.auto).toBe(false);
    expect(r.motifs.some(m => /absente/i.test(m))).toBe(true);
  });
});

function fauxRequest(overrides: Partial<(typeof fauxRequests)[number]> = {}) {
  return {
    id: 1,
    expediteur: "assurance@suva.ch",
    extraction: {
      patient: { nom: "Dupont", prenom: "Jean", ddn: "01.01.1980", tel: null },
      exams: [
        {
          modalite: "CT",
          dateDemandee: "01.06.2026",
          description: "Scanner cheville",
        },
      ],
      refSinistre: "SIN-123",
      adresseReponse: "reponse@suva.ch",
      confiance: 0.9,
    },
    patientId: 5,
    studyIds: [10],
    adresseReponse: "reponse@suva.ch",
    statut: "prete",
    envoyeLe: null,
    envoyePar: null,
    erreur: null,
    ...overrides,
  };
}

describe("envoyerReponse", () => {
  beforeEach(() => {
    fauxRequests = [fauxRequest()];
    dernierEq = null;
    updateDoitEchouer = false;
    Object.values(mocks).forEach(m => m.mockReset());
    mocks.construireColis.mockResolvedValue({
      bundleKey: "insurer/1/bundle.zip",
      tailleOctets: 12345,
    });
    mocks.creerJeton.mockResolvedValue({ tokenClair: "jeton-clair-abc123" });
    mocks.sendEmail.mockResolvedValue({ success: true });
    mocks.getStudyById.mockResolvedValue({
      id: 10,
      patientName: "Jean Dupont",
      patientId: "MRN-1",
      birthDate: "1980-01-01",
      studyDate: "20260601",
      modality: "CT",
      studyDescription: "Scanner cheville",
      institution: null,
      referringPhysician: null,
      numberOfSeries: 1,
      numberOfInstances: 50,
    });
    mocks.recordAccess.mockResolvedValue(undefined);
  });

  it("compose le mail avec le lien contenant le jeton en clair + récap examens", async () => {
    const r = await envoyerReponse(1, {});
    expect(r).toEqual({ success: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const opts = mocks.sendEmail.mock.calls[0][0];
    expect(opts.to).toBe("reponse@suva.ch");
    expect(opts.html).toContain("/dl/jeton-clair-abc123");
    expect(opts.html).toMatch(/14 jours/);
    // Récap des examens (fixture extraction.exams[0].description) présent
    // dans le corps du mail.
    expect(opts.html).toContain("Scanner cheville");
  });

  it("garde egress : destinataire hors allow-list ⇒ pas d'envoi, statut erreur + motif", async () => {
    fauxRequests[0].adresseReponse = "reponse@evil.com";
    const r = await envoyerReponse(1, {});
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.construireColis).not.toHaveBeenCalled();
    expect(fauxRequests[0].statut).toBe("erreur");
    expect(fauxRequests[0].erreur).toBeTruthy();
  });

  it("succès : statut 'envoyee', envoyePar renseigné, access_logs journalisé", async () => {
    const r = await envoyerReponse(1, { valideParUserId: 42 });
    expect(r).toEqual({ success: true });
    expect(fauxRequests[0].statut).toBe("envoyee");
    expect(fauxRequests[0].envoyePar).toBe(42);
    expect(fauxRequests[0].envoyeLe).toBeInstanceOf(Date);
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, action: "insurer_send" })
    );
  });

  it("envoi automatique (sans valideParUserId) : envoyePar null, access_logs userId 0", async () => {
    const r = await envoyerReponse(1, {});
    expect(r).toEqual({ success: true });
    expect(fauxRequests[0].envoyePar).toBeNull();
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 0, action: "insurer_send" })
    );
  });

  it("échec d'envoi SMTP ⇒ statut erreur + motif, pas de transition 'envoyee'", async () => {
    mocks.sendEmail.mockResolvedValue({
      success: false,
      error: "SMTP indisponible",
    });
    const r = await envoyerReponse(1, {});
    expect(r).toEqual({ success: false, error: "SMTP indisponible" });
    expect(fauxRequests[0].statut).toBe("erreur");
    expect(fauxRequests[0].erreur).toBe("SMTP indisponible");
  });

  it("construireColis lève AVANT l'envoi ⇒ statut erreur + motif, aucun mail envoyé", async () => {
    mocks.construireColis.mockRejectedValue(new Error("MinIO indisponible"));
    const r = await envoyerReponse(1, {});
    expect(r).toEqual({ success: false, error: "MinIO indisponible" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fauxRequests[0].statut).toBe("erreur");
    expect(fauxRequests[0].erreur).toBe("MinIO indisponible");
  });

  it("db.update lève APRÈS un envoi réussi (même après retry) ⇒ résout {success:true}, pas de second sendEmail", async () => {
    updateDoitEchouer = true;
    const r = await envoyerReponse(1, {});
    // Invariant : le mail est déjà parti, la fonction ne doit jamais
    // signaler d'échec au-delà de ce point (cf. revue Task 6).
    expect(r).toEqual({ success: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // Le update ayant systématiquement rejeté, la ligne fauxRequests n'a pas
    // été mutée (best-effort épuisé) — pas de statut "envoyee" erroné ici.
    expect(fauxRequests[0].statut).toBe("prete");
  });
});
