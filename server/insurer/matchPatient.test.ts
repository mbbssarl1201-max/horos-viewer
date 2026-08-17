import { describe, it, expect, vi, beforeEach } from "vitest";

// On teste le matching multi-critère (nom+prénom+DDN, homonymes, études par
// modalité/date) sans dépendre d'une vraie base : `getDb` est mocké vers un
// faux drizzle chaînable (pattern repris de server/reports.lifecycle.test.ts),
// et `decryptField` est mocké identité (le chiffrement réel est testé dans
// server/_core/crypto.test.ts). `nameSearchKey` reste la VRAIE implémentation
// (fail-open sans ENCRYPTION_KEY en test) : `cle()` ci-dessous en est le miroir.
//
// `inArray`/`eq` de drizzle-orm sont mockés pour CAPTURER les valeurs passées
// par l'implémentation (clés nameSearch, patientId) : le faux `where().limit()`
// filtre ensuite RÉELLEMENT `fauxPatients`/`fauxStudies` sur ces valeurs — pas
// un mock qui ignore la condition et renvoie tout. Ça garantit que si
// l'implémentation oublie une des deux clés d'ordre nom/prénom, ou requête la
// mauvaise colonne, un test le détecte.

let fauxPatients: {
  id: number;
  nameSearch: string | null;
  birthDate: string | null;
  patientName?: string | null;
}[] = [];
let fauxStudies: {
  id: number;
  patientId: number;
  studyDate: string | null;
  modality: string | null;
}[] = [];

let dernierInArray: { values: unknown[] } | null = null;
let dernierEq: { value: unknown } | null = null;

vi.mock("../db", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    getDb: () => Promise.resolve(fakeDb()),
  };
});

vi.mock("../_core/crypto", async orig => {
  const actual = await orig<any>();
  return { ...actual, decryptField: (v: string | null) => v };
});

vi.mock("drizzle-orm", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    inArray: (_column: any, values: unknown[]) => {
      dernierInArray = { values };
      return { __mock: "inArray" };
    },
    eq: (_column: any, value: unknown) => {
      dernierEq = { value };
      return { __mock: "eq" };
    },
  };
});

function fakeDb() {
  return {
    select: () => ({
      from: (table: any) => ({
        where: (_c: any) => ({
          limit: (_n: any) => {
            if (table === patients) {
              const cles = dernierInArray?.values ?? [];
              return Promise.resolve(
                fauxPatients.filter(p => cles.includes(p.nameSearch))
              );
            }
            // studies : filtrage par patientId — eq (un seul) ou inArray
            // (tous les dossiers d'une même personne).
            const ids = dernierInArray?.values ?? [dernierEq?.value];
            return Promise.resolve(
              fauxStudies.filter(s => ids.includes(s.patientId))
            );
          },
        }),
        // Scan complet (repli variantes de matchPatient) : from().limit() sans where.
        limit: (_n: any) => {
          if (table === patients) return Promise.resolve(fauxPatients);
          return Promise.resolve(fauxStudies);
        },
      }),
    }),
  };
}

import { matchPatient, matchStudies, normaliserDate } from "./matchPatient";
import { patients } from "../../drizzle/schema";
import { nameSearchKey } from "../db";
import type { ExtractionDemande } from "./types";

/** Miroir de la clé de recherche produite par nameSearchKey (fail-open en test). */
function cle(s: string): string {
  return nameSearchKey(s)!;
}

beforeEach(() => {
  fauxPatients = [];
  fauxStudies = [];
  dernierInArray = null;
  dernierEq = null;
});

describe("normaliserDate", () => {
  it("accepte JJ.MM.AAAA", () => {
    expect(normaliserDate("12.03.1985")).toBe("19850312");
  });
  it("accepte JJ/MM/AAAA", () => {
    expect(normaliserDate("12/03/1985")).toBe("19850312");
  });
  it("accepte AAAA-MM-JJ (ISO)", () => {
    expect(normaliserDate("1985-03-12")).toBe("19850312");
  });
  it("rejette une date invalide (calendrier incohérent)", () => {
    expect(normaliserDate("31.02.2020")).toBeNull();
  });
  it("rejette un texte qui n'est pas une date", () => {
    expect(normaliserDate("pas une date")).toBeNull();
  });
  it("rejette null", () => {
    expect(normaliserDate(null)).toBeNull();
  });
});

describe("matchPatient", () => {
  it("patient unique, nom+prénom+DDN concordants ⇒ exact", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientId: 1 });
  });

  it("ordre prénom nom (DICOM inversé) reconnu aussi — la ligne ne matche QUE la clé inversée", async () => {
    // Preuve que les DEUX ordres sont interrogés : le faux drizzle filtre
    // réellement sur les valeurs passées à `inArray` (cf. mock drizzle-orm en
    // tête de fichier). Un patient "un peu partout" (nom seul) sert de bruit
    // et ne doit jamais remonter.
    fauxPatients = [
      { id: 3, nameSearch: cle("marie dupont"), birthDate: "19850312" },
      { id: 99, nameSearch: cle("dupont"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientId: 3, candidats: 1 });
  });

  it("homonymes départagés par la DDN", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
      { id: 2, nameSearch: cle("dupont marie"), birthDate: "19910708" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientId: 1 });
  });

  it("2 dossiers même nom+DDN = MÊME personne (doublons PACS) ⇒ exact, tous les ids", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
      { id: 2, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [1, 2],
      variante: false,
    });
  });

  it("doublon homonyme SANS DDN rattaché à la personne confirmée (aucun conflit)", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
      { id: 2, nameSearch: cle("dupont marie"), birthDate: null },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientIds: [1, 2] });
  });

  it("nom unique dont les fiches n'ont AUCUNE DDN ⇒ exact avec ddnAbsente:true (jamais d'auto)", async () => {
    fauxPatients = [
      { id: 4, nameSearch: cle("markovic aleksandar"), birthDate: null },
      { id: 5, nameSearch: cle("markovic aleksandar"), birthDate: null },
    ];
    const r = await matchPatient({
      nom: "Markovic",
      prenom: "Aleksandar",
      ddn: "25.10.2000",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [4, 5],
      ddnAbsente: true,
      variante: false,
    });
  });

  it("homonyme d'une AUTRE personne (DDN différente) ⇒ les fiches sans DDN ne sont PAS rattachées", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
      { id: 2, nameSearch: cle("dupont marie"), birthDate: null },
      { id: 3, nameSearch: cle("dupont marie"), birthDate: "19900101" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientIds: [1] });
  });

  it("variante d'orthographe (Dzuka/Xhuka) + DDN exacte ⇒ exact via repli, variante:true", async () => {
    fauxPatients = [
      {
        id: 7,
        nameSearch: cle("xhuka bekim"),
        patientName: "XHUKA^BEKIM",
        birthDate: "19860830",
      },
    ];
    const r = await matchPatient({
      nom: "Dzuka",
      prenom: "Bekim",
      ddn: "30.08.1986",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [7],
      variante: true,
    });
  });

  it("repli : nom d'épouse surnuméraire toléré (Kopácová Jahiri vs Kopacova) + DDN exacte", async () => {
    fauxPatients = [
      {
        id: 8,
        nameSearch: cle("kopacova marcela"),
        patientName: "KOPACOVA^MARCELA",
        birthDate: "19790926",
      },
    ];
    const r = await matchPatient({
      nom: "Kopácová Jahiri",
      prenom: "Marcela",
      ddn: "26.09.1979",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [8],
      variante: true,
    });
  });

  it("repli : même DDN mais nom SANS rapport ⇒ aucun (jamais la DDN seule)", async () => {
    fauxPatients = [
      {
        id: 9,
        nameSearch: cle("ros maxime"),
        patientName: "ROS^MAXIME JOSE",
        birthDate: "19930523",
      },
    ];
    const r = await matchPatient({
      nom: "Qarri",
      prenom: "Egzona",
      ddn: "23.05.1993",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null });
  });

  // Cas réel #26 : la feuille SUVA porte le nom complet composé (« Neziri dos
  // Santos Silva Zjavere ») mais la fiche PACS du backfill est « NEZIRI^ZJAVERE »
  // SANS date de naissance. L'index (nom exact) rate, et le repli DDN-exacte ne
  // peut rien vérifier : on accepte quand même quand le nom est compatible et
  // qu'il n'y a AUCUNE ambiguïté — ddnAbsente+variante interdisent l'envoi auto.
  it("repli : fiche SANS DDN + nom composé compatible ⇒ exact, variante+ddnAbsente", async () => {
    fauxPatients = [
      {
        id: 11,
        nameSearch: cle("neziri zjavere"),
        patientName: "NEZIRI^ZJAVERE",
        birthDate: null,
      },
      {
        id: 12,
        nameSearch: cle("neziri adnan"),
        patientName: "NEZIRI^ADNAN",
        birthDate: "19960327",
      },
    ];
    const r = await matchPatient({
      nom: "Neziri dos Santos Silva",
      prenom: "Zjavere",
      ddn: "16.02.1986",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [11],
      variante: true,
      ddnAbsente: true,
    });
  });

  // Cas réel #9 : « PATRICIO LOPES V » (nom inversé + prénom tronqué, sans DDN)
  // pour la feuille « Lopes Victor Manuel Patrício ». Les DOUBLONS PACS de la
  // même personne (noms compatibles entre eux) sont tous rattachés.
  it("repli sans DDN : doublons PACS de la même personne ⇒ tous les dossiers", async () => {
    fauxPatients = [
      {
        id: 21,
        nameSearch: cle("patricio lopes v"),
        patientName: "PATRICIO LOPES V",
        birthDate: null,
      },
      {
        id: 22,
        nameSearch: cle("patricio lopes v"),
        patientName: "PATRICIO LOPES V",
        birthDate: null,
      },
    ];
    const r = await matchPatient({
      nom: "Lopes",
      prenom: "Victor Manuel Patrício",
      ddn: "20.09.1964",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [21, 22],
      variante: true,
      ddnAbsente: true,
    });
  });

  it("repli sans DDN : deux fiches compatibles mais personnes DIFFÉRENTES ⇒ aucun", async () => {
    fauxPatients = [
      {
        id: 31,
        nameSearch: cle("patricio lopes v"),
        patientName: "PATRICIO LOPES V",
        birthDate: null,
      },
      {
        id: 32,
        nameSearch: cle("lopes manuel"),
        patientName: "LOPES^MANUEL",
        birthDate: null,
      },
    ];
    const r = await matchPatient({
      nom: "Lopes",
      prenom: "Victor Manuel Patrício",
      ddn: "20.09.1964",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null });
  });

  it("repli sans DDN : homonyme compatible avec une AUTRE DDN ⇒ aucun (conflit)", async () => {
    fauxPatients = [
      {
        id: 41,
        nameSearch: cle("dupont marie"),
        patientName: "DUPONT^MARIE",
        birthDate: null,
      },
      {
        id: 42,
        nameSearch: cle("dupont marie claire"),
        patientName: "DUPONT^MARIE CLAIRE",
        birthDate: "19900101",
      },
    ];
    const r = await matchPatient({
      // « Dupond » (typo) pour que l'index rate et que le repli s'applique.
      nom: "Dupond",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null });
  });

  it("repli : une fiche DDN exacte reste prioritaire sur les fiches sans DDN", async () => {
    fauxPatients = [
      {
        id: 51,
        nameSearch: cle("xhuka bekim"),
        patientName: "XHUKA^BEKIM",
        birthDate: "19860830",
      },
      {
        id: 52,
        nameSearch: cle("xhuka bekim"),
        patientName: "XHUKA^BEKIM",
        birthDate: null,
      },
    ];
    const r = await matchPatient({
      nom: "Dzuka",
      prenom: "Bekim",
      ddn: "30.08.1986",
      tel: null,
    });
    expect(r).toMatchObject({
      statut: "exact",
      patientIds: [51],
      variante: true,
      ddnAbsente: false,
    });
  });

  it("sans DDN, jamais exact même si patient unique", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: null,
      tel: null,
    });
    expect(r.statut).toBe("ambigu");
  });

  it("DDN fournie mais ne concordant avec aucun homonyme ⇒ aucun (jamais exact)", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "01.01.2000",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null });
  });

  it("aucune correspondance de nom ⇒ aucun (le faux drizzle filtre réellement, ne renvoie pas l'homonyme non demandé)", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("martin paul"), birthDate: "19700101" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null, candidats: 0 });
  });

  it("nom ou prénom absent ⇒ aucun (jamais de DDN seule)", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: null,
      prenom: null,
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "aucun", patientId: null, candidats: 0 });
  });
});

describe("matchStudies", () => {
  const exam = (
    over: Partial<ExtractionDemande["exams"][number]> = {}
  ): ExtractionDemande["exams"][number] => ({
    modalite: "CT",
    dateDemandee: "02.06.2026",
    description: "CT colonne lombaire",
    ...over,
  });

  it("date exacte, modalité concordante", async () => {
    fauxStudies = [
      { id: 10, patientId: 1, studyDate: "20260602", modality: "CT" },
    ];
    const r = await matchStudies(1, [exam()]);
    expect(r.tousTrouves).toBe(true);
    expect(r.datesExactes).toBe(true);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [10], dateExacte: true });
  });

  it("pas de date exacte mais une étude à ±7 jours ⇒ dateExacte:false", async () => {
    fauxStudies = [
      { id: 11, patientId: 1, studyDate: "20260607", modality: "CT" }, // +5j
    ];
    const r = await matchStudies(1, [exam()]);
    expect(r.tousTrouves).toBe(true);
    expect(r.datesExactes).toBe(false);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [11], dateExacte: false });
  });

  it("hors fenêtre ±7 jours ⇒ introuvable", async () => {
    fauxStudies = [
      { id: 12, patientId: 1, studyDate: "20260620", modality: "CT" }, // +18j
    ];
    const r = await matchStudies(1, [exam()]);
    expect(r.tousTrouves).toBe(false);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [], dateExacte: false });
  });

  it("modalité différente exclue même à date exacte", async () => {
    fauxStudies = [
      { id: 13, patientId: 1, studyDate: "20260602", modality: "MR" },
    ];
    const r = await matchStudies(1, [exam({ modalite: "CT" })]);
    expect(r.tousTrouves).toBe(false);
    expect(r.parExamen[0].studyIds).toEqual([]);
  });

  it("modalité absente dans la demande ⇒ tolérée, toutes modalités acceptées", async () => {
    fauxStudies = [
      { id: 14, patientId: 1, studyDate: "20260602", modality: "MR" },
    ];
    const r = await matchStudies(1, [exam({ modalite: null })]);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [14], dateExacte: true });
  });

  it("fenêtre ±7 jours traverse un changement de mois (28.06 vs demandée 02.07)", async () => {
    fauxStudies = [
      { id: 22, patientId: 1, studyDate: "20260628", modality: "CT" }, // 4j avant le 02.07
    ];
    const r = await matchStudies(1, [exam({ dateDemandee: "02.07.2026" })]);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [22], dateExacte: false });
  });

  it("date demandée absente/invalide ⇒ candidats de la modalité renvoyés (dateExacte:false), pas une liste vide", async () => {
    fauxStudies = [
      { id: 20, patientId: 1, studyDate: "20260101", modality: "CT" },
      { id: 21, patientId: 1, studyDate: "20260601", modality: "MR" },
    ];
    const r = await matchStudies(1, [exam({ dateDemandee: null })]);
    expect(r.parExamen[0]).toMatchObject({ studyIds: [20], dateExacte: false });
    expect(r.datesExactes).toBe(false);
  });
});
