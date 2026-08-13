import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { insurerRequests } from "../../drizzle/schema";

// Toutes les dépendances externes sont mockées (pattern repris de
// server/insurer/packageAndSend.test.ts et matchPatient.test.ts) :
// `imapflow`/`mailparser`/`pdf-parse` (E/S réseau + parsing), `../db`,
// `../storage`, `../email`, `./extractRequest`, `./matchPatient`,
// `./packageAndSend`. `drizzle-orm` est mocké pour CAPTURER la colonne+valeur
// du dernier `eq(...)` (plusieurs colonnes distinctes sont interrogées sur
// `insurerRequests` — messageId, id, statut — d'où le besoin de retenir la
// colonne, pas seulement la valeur comme dans les autres tests du dossier).

const mocks = {
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn(),
  logout: vi.fn(),
  simpleParser: vi.fn(),
  pdfParse: vi.fn(),
  storagePut: vi.fn(),
  storageGetBuffer: vi.fn(),
  sendEmail: vi.fn(),
  extraireDemande: vi.fn(),
  matchPatient: vi.fn(),
  matchStudies: vi.fn(),
  decideEnvoiAuto: vi.fn(),
  envoyerReponse: vi.fn(),
};

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: (...a: any[]) => mocks.connect(...a),
    getMailboxLock: (...a: any[]) => mocks.getMailboxLock(...a),
    fetch: (...a: any[]) => mocks.fetch(...a),
    messageFlagsAdd: (...a: any[]) => mocks.messageFlagsAdd(...a),
    logout: (...a: any[]) => mocks.logout(...a),
  })),
}));

vi.mock("mailparser", () => ({
  simpleParser: (...a: any[]) => mocks.simpleParser(...a),
}));

vi.mock("pdf-parse", () => ({
  default: (...a: any[]) => mocks.pdfParse(...a),
}));

vi.mock("../storage", () => ({
  storagePut: (...a: any[]) => mocks.storagePut(...a),
  storageGetBuffer: (...a: any[]) => mocks.storageGetBuffer(...a),
}));

vi.mock("../email", () => ({
  sendEmail: (...a: any[]) => mocks.sendEmail(...a),
}));

vi.mock("./extractRequest", () => ({
  extraireDemande: (...a: any[]) => mocks.extraireDemande(...a),
}));

vi.mock("./matchPatient", () => ({
  matchPatient: (...a: any[]) => mocks.matchPatient(...a),
  matchStudies: (...a: any[]) => mocks.matchStudies(...a),
}));

vi.mock("./packageAndSend", () => ({
  decideEnvoiAuto: (...a: any[]) => mocks.decideEnvoiAuto(...a),
  envoyerReponse: (...a: any[]) => mocks.envoyerReponse(...a),
}));

vi.mock("../_core/env", async orig => {
  const actual = await orig<any>();
  return {
    ENV: {
      ...actual.ENV,
      insurerImapHost: "imap.example.com",
      insurerImapPort: 993,
      insurerImapUser: "agent@example.com",
      insurerImapPass: "secret",
      insurerImapMailbox: "INBOX",
      insurerTrustedSenders: ["assurance@suva.ch"],
      insurerAutoSendDomains: ["suva.ch"],
      insurerNotifyEmail: "gerant@example.com",
    },
  };
});

let dernierEq: { column: unknown; value: unknown } | null = null;
vi.mock("drizzle-orm", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    eq: (column: any, value: unknown) => {
      dernierEq = { column, value };
      return { __mock: "eq" };
    },
  };
});

import { ENV } from "../_core/env";
import {
  traiterBoite,
  traiterDemande,
  demarrerPollerAssureur,
  MOTIF_PDF_SCANNE,
} from "./mailPoller";

let fauxRequests: Record<string, any>[] = [];
let prochainId = 1;

function fakeDb() {
  const filtrer = (cond: { column: unknown; value: unknown } | null) => {
    if (!cond) return [...fauxRequests];
    if (cond.column === insurerRequests.messageId) {
      return fauxRequests.filter(r => r.messageId === cond.value);
    }
    if (cond.column === insurerRequests.id) {
      return fauxRequests.filter(r => r.id === cond.value);
    }
    if (cond.column === insurerRequests.statut) {
      return fauxRequests.filter(r => r.statut === cond.value);
    }
    return [];
  };
  return {
    select: () => ({
      from: (_table: any) => ({
        where: (_c: any) => {
          const cond = dernierEq;
          return { limit: (_n: any) => Promise.resolve(filtrer(cond)) };
        },
      }),
    }),
    insert: (_table: any) => ({
      values: (v: any) => {
        const row = {
          id: prochainId++,
          extraction: null,
          patientId: null,
          studyIds: null,
          motifValidation: null,
          envoyeLe: null,
          envoyePar: null,
          erreur: null,
          ...v,
        };
        fauxRequests.push(row);
        return Promise.resolve({ insertId: row.id });
      },
    }),
    update: (_table: any) => ({
      set: (v: any) => ({
        where: (_c: any) => {
          const cond = dernierEq;
          const [row] = filtrer(cond);
          if (row) Object.assign(row, v);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

vi.mock("../db", async orig => {
  const actual = await orig<any>();
  return { ...actual, getDb: () => Promise.resolve(fakeDb()) };
});

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () =>
          i < items.length
            ? { value: items[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

function fauxParsedMail(overrides: Record<string, any> = {}) {
  return {
    messageId: "<defaut@test>",
    from: { value: [{ address: "assurance@suva.ch" }] },
    replyTo: undefined,
    subject: "Demande imagerie",
    text: "Bonjour, merci de transmettre l'imagerie du patient.",
    date: new Date("2026-08-01T10:00:00Z"),
    attachments: [],
    ...overrides,
  };
}

const EXTRACTION_NOMINALE = {
  patient: { nom: "Dupont", prenom: "Jean", ddn: "01.01.1980", tel: null },
  exams: [
    {
      modalite: "CT",
      dateDemandee: "01.06.2026",
      description: "Scanner cheville",
    },
  ],
  refSinistre: "SIN-123",
  adresseReponse: null,
  confiance: 0.9,
};

beforeEach(() => {
  fauxRequests = [];
  prochainId = 1;
  dernierEq = null;
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.connect.mockResolvedValue(undefined);
  mocks.getMailboxLock.mockResolvedValue({ release: vi.fn() });
  mocks.messageFlagsAdd.mockResolvedValue(true);
  mocks.logout.mockResolvedValue(undefined);
  mocks.storagePut.mockImplementation((key: string) =>
    Promise.resolve({ key, url: `https://minio.example/${key}` })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("traiterBoite — idempotence", () => {
  it("2 messages avec le même messageId ⇒ 1 seule ligne créée, les deux marqués lus", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([
        { uid: 1, source: Buffer.from("m1") },
        { uid: 2, source: Buffer.from("m2") },
      ])
    );
    mocks.simpleParser.mockResolvedValue(
      fauxParsedMail({ messageId: "<dup@suva.ch>" })
    );

    const count = await traiterBoite();

    expect(fauxRequests.length).toBe(1);
    expect(count).toBe(1);
    expect(mocks.messageFlagsAdd).toHaveBeenCalledTimes(2);
    expect(mocks.messageFlagsAdd).toHaveBeenNthCalledWith(1, 1, ["\\Seen"]);
    expect(mocks.messageFlagsAdd).toHaveBeenNthCalledWith(2, 2, ["\\Seen"]);
  });

  it("no-op (0, pas de connexion) quand INSURER_IMAP_HOST est vide", async () => {
    const avant = ENV.insurerImapHost;
    (ENV as any).insurerImapHost = "";
    try {
      const count = await traiterBoite();
      expect(count).toBe(0);
      expect(mocks.connect).not.toHaveBeenCalled();
    } finally {
      (ENV as any).insurerImapHost = avant;
    }
  });
});

describe("traiterBoite — pièces jointes", () => {
  it("image ⇒ stockée telle quelle (vision), corps texte inchangé", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 10, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<img@suva.ch>",
        attachments: [
          {
            contentType: "image/jpeg",
            content: Buffer.from("fake-jpeg-bytes"),
          },
        ],
      })
    );

    await traiterBoite();

    expect(fauxRequests.length).toBe(1);
    const row = fauxRequests[0];
    expect(row.attachmentKeys).toEqual(["insurer/1/img-0.jpg"]);
    expect(mocks.storagePut).toHaveBeenCalledWith(
      "insurer/1/img-0.jpg",
      expect.any(Buffer),
      "image/jpeg"
    );
    expect(row.corpsTexte).toBe(
      "Bonjour, merci de transmettre l'imagerie du patient."
    );
  });

  it("PDF lisible (≥80 caractères) ⇒ texte concaténé au corps", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 11, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<pdf-ok@suva.ch>",
        attachments: [
          { contentType: "application/pdf", content: Buffer.from("%PDF-1.4") },
        ],
      })
    );
    const texteLong = "A".repeat(120);
    mocks.pdfParse.mockResolvedValueOnce({ text: texteLong });

    await traiterBoite();

    const row = fauxRequests[0];
    expect(row.attachmentKeys).toEqual(["insurer/1/doc-0.pdf"]);
    expect(row.corpsTexte).toContain(texteLong);
    expect(row.corpsTexte).not.toContain("PDF_NON_LISIBLE");
  });
});

describe("traiterDemande", () => {
  function seedRow(overrides: Record<string, any> = {}) {
    const row = {
      id: prochainId++,
      messageId: `<seed-${prochainId}@suva.ch>`,
      expediteur: "assurance@suva.ch",
      sujet: "Demande",
      recuLe: new Date(),
      statut: "recue",
      corpsTexte: "Corps du mail.",
      attachmentKeys: [],
      extraction: null,
      patientId: null,
      studyIds: null,
      adresseReponse: "reponse@suva.ch",
      motifValidation: null,
      envoyeLe: null,
      envoyePar: null,
      erreur: null,
      ...overrides,
    };
    fauxRequests.push(row);
    return row;
  }

  it("(a) chemin auto complet ⇒ envoyerReponse appelé, pas de notification", async () => {
    const row = seedRow();
    mocks.extraireDemande.mockResolvedValue(EXTRACTION_NOMINALE);
    mocks.matchPatient.mockResolvedValue({
      statut: "exact",
      patientId: 5,
      candidats: 1,
    });
    mocks.matchStudies.mockResolvedValue({
      tousTrouves: true,
      datesExactes: true,
      parExamen: [
        {
          exam: EXTRACTION_NOMINALE.exams[0],
          studyIds: [10],
          dateExacte: true,
        },
      ],
    });
    mocks.decideEnvoiAuto.mockReturnValue({ auto: true, motifs: [] });
    mocks.envoyerReponse.mockResolvedValue({ success: true });

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).toHaveBeenCalledWith(row.id, {});
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(row.extraction).toEqual(EXTRACTION_NOMINALE);
    expect(row.patientId).toBe(5);
    expect(row.studyIds).toEqual([10]);
  });

  it("(b) match ambigu ⇒ statut a_valider, motifs persistés, notification envoyée", async () => {
    const row = seedRow();
    mocks.extraireDemande.mockResolvedValue(EXTRACTION_NOMINALE);
    mocks.matchPatient.mockResolvedValue({
      statut: "ambigu",
      patientId: null,
      candidats: 2,
    });
    mocks.decideEnvoiAuto.mockReturnValue({
      auto: false,
      motifs: [
        "Identification du patient ambiguë (plusieurs correspondances possibles)",
      ],
    });

    await traiterDemande(row.id);

    expect(mocks.matchStudies).not.toHaveBeenCalled();
    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.motifValidation).toContain("Identification du patient ambiguë");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const opts = mocks.sendEmail.mock.calls[0][0];
    expect(opts.to).toBe("gerant@example.com");
    expect(opts.html).toContain("Identification du patient ambiguë");
  });

  it("(c) extraireDemande lève ⇒ statut erreur, pas de crash", async () => {
    const row = seedRow();
    mocks.extraireDemande.mockRejectedValue(new Error("boom vision API"));

    await expect(traiterDemande(row.id)).resolves.toBeUndefined();

    expect(row.statut).toBe("erreur");
    expect(row.erreur).toContain("boom vision API");
    expect(mocks.matchPatient).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
  });

  it("(d) PDF scanné non lisible (via traiterBoite) ⇒ motif présent, auto JAMAIS vrai même si decideEnvoiAuto dit oui", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 20, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<pdf-scanne@suva.ch>",
        attachments: [
          {
            contentType: "application/pdf",
            content: Buffer.from("%PDF-1.4 scanned"),
          },
        ],
      })
    );
    mocks.pdfParse.mockResolvedValueOnce({ text: "trop court" }); // <80 caractères

    await traiterBoite();
    const row = fauxRequests[0];
    expect(row.corpsTexte).toMatch(/PDF_NON_LISIBLE/);

    mocks.extraireDemande.mockResolvedValue(EXTRACTION_NOMINALE);
    mocks.matchPatient.mockResolvedValue({
      statut: "exact",
      patientId: 5,
      candidats: 1,
    });
    mocks.matchStudies.mockResolvedValue({
      tousTrouves: true,
      datesExactes: true,
      parExamen: [
        {
          exam: EXTRACTION_NOMINALE.exams[0],
          studyIds: [10],
          dateExacte: true,
        },
      ],
    });
    // Piège volontaire : decideEnvoiAuto répond "auto" alors que le PDF
    // scanné doit quand même bloquer l'envoi automatique.
    mocks.decideEnvoiAuto.mockReturnValue({ auto: true, motifs: [] });

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.motifValidation).toContain(MOTIF_PDF_SCANNE);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);

    // Le marqueur interne ne doit jamais être transmis à l'extraction LLM.
    const argExtraction = mocks.extraireDemande.mock.calls[0][0];
    expect(argExtraction.texte).not.toMatch(/PDF_NON_LISIBLE/);
  });
});

describe("demarrerPollerAssureur", () => {
  it("no-op quand INSURER_IMAP_HOST est vide (aucun setInterval enregistré)", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, "setInterval");
    const avant = ENV.insurerImapHost;
    (ENV as any).insurerImapHost = "";
    try {
      demarrerPollerAssureur();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      (ENV as any).insurerImapHost = avant;
      spy.mockRestore();
    }
  });
});
