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
  rasteriserPdf: vi.fn(),
  etudesSansImages: vi.fn(),
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

vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: (...a: any[]) => mocks.pdfParse(...a),
}));

vi.mock("./pdfRaster", () => ({
  rasteriserPdf: (...a: any[]) => mocks.rasteriserPdf(...a),
}));

vi.mock("./backfill", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    etudesSansImages: (...a: any[]) => mocks.etudesSansImages(...a),
  };
});

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
  // Par défaut la rastérisation ne produit rien : les tests historiques du
  // motif « PDF scanné » restent représentatifs (pdftoppm absent/échec).
  mocks.rasteriserPdf.mockResolvedValue([]);
  // Par défaut les études trouvées ont leurs images : les tests d'envoi auto
  // ne sont pas bloqués par le motif de rapatriement.
  mocks.etudesSansImages.mockResolvedValue(false);
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
    expect(row.corpsTexte).not.toMatch(/\[\[MOTIF:/);
  });
});

describe("traiterBoite — échecs transitoires / dead-letter", () => {
  it("échec transitoire (1re tentative) ⇒ message NON marqué lu, aucune ligne créée", async () => {
    mocks.fetch.mockImplementation(() =>
      asyncIterable([{ uid: 30, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockRejectedValue(new Error("parse cassé"));

    const count = await traiterBoite();

    expect(count).toBe(0);
    expect(fauxRequests.length).toBe(0);
    expect(mocks.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("échec persistant (3 passes) ⇒ marqué lu + ligne dead-letter statut erreur, jamais avant", async () => {
    mocks.fetch.mockImplementation(() =>
      asyncIterable([{ uid: 31, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockRejectedValue(new Error("DB indisponible"));

    await traiterBoite(); // tentative 1 : toujours en échec
    expect(mocks.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fauxRequests.length).toBe(0);

    await traiterBoite(); // tentative 2 : toujours en échec
    expect(mocks.messageFlagsAdd).not.toHaveBeenCalled();
    expect(fauxRequests.length).toBe(0);

    const count = await traiterBoite(); // tentative 3 : abandon (dead-letter)

    expect(count).toBe(1);
    expect(mocks.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(mocks.messageFlagsAdd).toHaveBeenCalledWith(31, ["\\Seen"]);
    expect(fauxRequests.length).toBe(1);
    const row = fauxRequests[0];
    expect(row.statut).toBe("erreur");
    expect(row.messageId).toMatch(/^sans-traitement:uid-31:/);
    expect(row.erreur).toContain("Abandonné après 3 tentatives");
    expect(row.erreur).toContain("DB indisponible");
  });
});

describe("traiterBoite — bornes de taille des pièces jointes", () => {
  it("PJ >25 Mo ⇒ ignorée + motif, auto JAMAIS vrai même si decideEnvoiAuto dit oui", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 40, source: Buffer.from("m") }])
    );
    const grosBuffer = Buffer.alloc(26 * 1024 * 1024);
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<gros-pj@suva.ch>",
        attachments: [
          {
            contentType: "image/jpeg",
            filename: "gros-scan.jpg",
            content: grosBuffer,
          },
        ],
      })
    );

    await traiterBoite();
    const row = fauxRequests[0];
    expect(row.attachmentKeys).toEqual([]);
    expect(mocks.storagePut).not.toHaveBeenCalled();
    expect(row.corpsTexte).toContain("trop volumineuse");
    expect(row.corpsTexte).toContain("gros-scan.jpg");

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
    // Piège volontaire, comme pour le PDF scanné : decideEnvoiAuto répond
    // "auto" alors que la PJ trop volumineuse doit quand même bloquer l'envoi.
    mocks.decideEnvoiAuto.mockReturnValue({ auto: true, motifs: [] });

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.motifValidation).toContain("trop volumineuse");
    expect(row.motifValidation).toContain("gros-scan.jpg");
  });

  it("nom de PJ malveillant (<script>) + oversize ⇒ notification HTML échappée, jamais de balise brute", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 42, source: Buffer.from("m") }])
    );
    const grosBuffer = Buffer.alloc(26 * 1024 * 1024);
    const nomMalveillant = "<script>alert(1)</script>.jpg";
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<xss-pj@suva.ch>",
        attachments: [
          {
            contentType: "image/jpeg",
            filename: nomMalveillant,
            content: grosBuffer,
          },
        ],
      })
    );

    await traiterBoite();
    const row = fauxRequests[0];

    mocks.extraireDemande.mockResolvedValue(EXTRACTION_NOMINALE);
    mocks.matchPatient.mockResolvedValue({
      statut: "ambigu",
      patientId: null,
      candidats: 2,
    });
    mocks.decideEnvoiAuto.mockReturnValue({
      auto: false,
      motifs: ["Identification du patient ambiguë"],
    });

    await traiterDemande(row.id);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const html = mocks.sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("image de type non mappé (heic) ⇒ archivée pour dossier + motif de validation", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 41, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<heic@suva.ch>",
        attachments: [
          {
            contentType: "image/heic",
            filename: "photo.heic",
            content: Buffer.from("fake-heic-bytes"),
          },
        ],
      })
    );

    await traiterBoite();

    const row = fauxRequests[0];
    expect(row.attachmentKeys).toEqual(["insurer/1/piece-0"]);
    expect(row.corpsTexte).toContain(
      "non exploitable automatiquement (image/heic)"
    );
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

  it("(d2) PDF scanné rastérisable ⇒ pages stockées en img-N.png (circuit vision), AUCUN motif « PDF scanné »", async () => {
    mocks.fetch.mockReturnValue(
      asyncIterable([{ uid: 21, source: Buffer.from("m") }])
    );
    mocks.simpleParser.mockResolvedValueOnce(
      fauxParsedMail({
        messageId: "<pdf-scanne-raster@suva.ch>",
        attachments: [
          {
            contentType: "application/pdf",
            content: Buffer.from("%PDF-1.4 scanned"),
          },
        ],
      })
    );
    mocks.pdfParse.mockResolvedValueOnce({ text: "trop court" }); // <80 caractères
    mocks.rasteriserPdf.mockResolvedValueOnce([
      Buffer.from("png-page-1"),
      Buffer.from("png-page-2"),
    ]);

    await traiterBoite();
    const row = fauxRequests[0];
    expect(row.corpsTexte).not.toContain(MOTIF_PDF_SCANNE);
    expect(mocks.storagePut).toHaveBeenCalledWith(
      expect.stringMatching(/img-0\.png$/),
      expect.anything(),
      "image/png"
    );
    expect(mocks.storagePut).toHaveBeenCalledWith(
      expect.stringMatching(/img-1\.png$/),
      expect.anything(),
      "image/png"
    );
    // Les clés PNG sont référencées : `traiterDemande` les passera à la vision.
    expect(
      (row.attachmentKeys as string[]).filter(k => k.endsWith(".png"))
    ).toHaveLength(2);
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
    expect(row.corpsTexte).toContain(MOTIF_PDF_SCANNE);

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
    expect(argExtraction.texte).not.toMatch(/\[\[MOTIF:/);
  });

  // Audit C1 : `extraction.adresseReponse` est du texte libre lu par le LLM
  // dans le corps du mail — un attaquant qui se fait passer pour l'assureur
  // peut y écrire une liste pour se faire mettre en copie du colis DICOM+CR.
  it("(e) adresseReponse extraite smugglée (virgule) ⇒ motif + a_valider, jamais auto même si tout le reste est parfait", async () => {
    const row = seedRow({ adresseReponse: "reponse@suva.ch" });
    mocks.extraireDemande.mockResolvedValue({
      ...EXTRACTION_NOMINALE,
      adresseReponse: "attacker@evil.com, dossier@suva.ch",
    });
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
    // Piège volontaire, comme pour le PDF scanné/la PJ volumineuse :
    // decideEnvoiAuto répond "auto" alors que l'adresse extraite smugglée
    // doit quand même bloquer l'envoi automatique.
    mocks.decideEnvoiAuto.mockReturnValue({ auto: true, motifs: [] });

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.motifValidation).toContain(
      "Adresse de réponse invalide ou multiple"
    );
    // Repli sur l'adresse déjà persistée à l'ingestion (Reply-To/From du
    // mail) — jamais la chaîne smugglée telle quelle, jamais l'un des deux
    // segments qu'elle contient.
    expect(row.adresseReponse).toBe("reponse@suva.ch");
    expect(mocks.decideEnvoiAuto).toHaveBeenCalledWith(
      expect.objectContaining({ adresseReponse: "reponse@suva.ch" })
    );
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("(f) adresseReponse extraite smugglée ET adresse persistée invalide ⇒ adresseReponse null, a_valider", async () => {
    const row = seedRow({ adresseReponse: "pas-une-adresse" });
    mocks.extraireDemande.mockResolvedValue({
      ...EXTRACTION_NOMINALE,
      adresseReponse: "attacker@evil.com, dossier@suva.ch",
    });
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

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.adresseReponse).toBeNull();
    expect(mocks.decideEnvoiAuto).toHaveBeenCalledWith(
      expect.objectContaining({ adresseReponse: null })
    );
  });

  // Décision gérant 2026-08-14 : la réponse part TOUJOURS à la même adresse
  // SUVA (INSURER_REPLY_TO) — l'adresse lue dans le courrier est ignorée,
  // y compris une adresse smugglée.
  it("(g) INSURER_REPLY_TO posé ⇒ la destination forcée prime sur l'adresse extraite ET la persistée", async () => {
    const avant = ENV.insurerReplyTo;
    (ENV as any).insurerReplyTo = "suva.ouest@suva.ch";
    try {
      const row = seedRow({ adresseReponse: "reponse@suva.ch" });
      mocks.extraireDemande.mockResolvedValue({
        ...EXTRACTION_NOMINALE,
        adresseReponse: "attacker@evil.com, dossier@suva.ch",
      });
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
      mocks.decideEnvoiAuto.mockReturnValue({ auto: false, motifs: ["x"] });

      await traiterDemande(row.id);

      expect(row.adresseReponse).toBe("suva.ouest@suva.ch");
      // Pas de motif « adresse invalide » : la chaîne smugglée n'est même pas
      // considérée quand la destination est forcée.
      expect(row.motifValidation ?? "").not.toContain(
        "Adresse de réponse invalide ou multiple"
      );
      expect(mocks.decideEnvoiAuto).toHaveBeenCalledWith(
        expect.objectContaining({ adresseReponse: "suva.ouest@suva.ch" })
      );
    } finally {
      (ENV as any).insurerReplyTo = avant;
    }
  });

  // Rattrapage : demande reçue avant la rastérisation (PDF stocké, aucune
  // image) ⇒ re-traitement re-rastérise le PDF, persiste les PNG et les
  // transmet à la vision.
  it("(i) re-traitement rastérise un PDF stocké sans image et persiste les PNG", async () => {
    const row = seedRow({
      attachmentKeys: ["insurer/1/doc-0.pdf"],
      corpsTexte: `Corps. ${"[[MOTIF:PDF scanné non lisible automatiquement]]"}`,
    });
    mocks.storageGetBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 scan"));
    mocks.rasteriserPdf.mockResolvedValue([
      Buffer.from("png-1"),
      Buffer.from("png-2"),
    ]);
    mocks.extraireDemande.mockResolvedValue(EXTRACTION_NOMINALE);
    mocks.matchPatient.mockResolvedValue({
      statut: "aucun",
      patientId: null,
      candidats: 0,
    });
    mocks.matchStudies.mockResolvedValue({
      tousTrouves: false,
      datesExactes: false,
      parExamen: [],
    });
    mocks.decideEnvoiAuto.mockReturnValue({ auto: false, motifs: ["x"] });

    await traiterDemande(row.id);

    // Les pages rastérisées sont stockées en reimg-N.png…
    expect(mocks.storagePut).toHaveBeenCalledWith(
      expect.stringMatching(/reimg-0\.png$/),
      expect.anything(),
      "image/png"
    );
    // …ajoutées à attachmentKeys (persisté)…
    expect(row.attachmentKeys).toEqual(
      expect.arrayContaining([
        "insurer/1/doc-0.pdf",
        expect.stringMatching(/reimg-0\.png$/),
        expect.stringMatching(/reimg-1\.png$/),
      ])
    );
    // …et transmises à la vision (2 images).
    expect(mocks.extraireDemande).toHaveBeenCalledWith(
      expect.objectContaining({ images: expect.arrayContaining([]) })
    );
    expect(mocks.extraireDemande.mock.calls[0][0].images).toHaveLength(2);
  });

  // Backfill : étude trouvée mais fiche méta-seule (images pas encore
  // rapatriées du PACS) ⇒ motif posé, envoi auto JAMAIS vrai.
  it("(h) étude sans images ⇒ motif rapatriement + a_valider, auto JAMAIS même si decideEnvoiAuto dit oui", async () => {
    const row = seedRow({ adresseReponse: "reponse@suva.ch" });
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
    mocks.etudesSansImages.mockResolvedValue(true); // fiche méta-seule
    mocks.decideEnvoiAuto.mockReturnValue({ auto: true, motifs: [] });

    await traiterDemande(row.id);

    expect(mocks.envoyerReponse).not.toHaveBeenCalled();
    expect(row.statut).toBe("a_valider");
    expect(row.motifValidation).toContain("Images en cours de rapatriement");
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

  // Audit I5 : un domaine d'auto-envoi non whitelisté à l'egress échouerait
  // TOUJOURS silencieusement (visible seulement en base, `erreur`) — le
  // gérant doit être averti dès le démarrage, pas après un envoi manqué.
  it("avertit si un domaine INSURER_AUTO_SEND_DOMAINS est absent de REPORT_EMAIL_ALLOWED_DOMAINS, puis logue le démarrage (M6)", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const avantAuto = ENV.insurerAutoSendDomains;
    const avantAllowed = ENV.reportEmailAllowedDomains;
    (ENV as any).insurerAutoSendDomains = ["suva.ch"];
    (ENV as any).reportEmailAllowedDomains = ["gmail.com"];
    try {
      demarrerPollerAssureur();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("suva.ch"));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("REPORT_EMAIL_ALLOWED_DOMAINS")
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("poller IMAP démarré")
      );
    } finally {
      (ENV as any).insurerAutoSendDomains = avantAuto;
      (ENV as any).reportEmailAllowedDomains = avantAllowed;
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
