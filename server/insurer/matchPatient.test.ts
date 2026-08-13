import { describe, it, expect, vi, beforeEach } from "vitest";

// On teste le matching multi-critère (nom+prénom+DDN, homonymes, études par
// modalité/date) sans dépendre d'une vraie base : `getDb` est mocké vers un
// faux drizzle chaînable (pattern repris de server/reports.lifecycle.test.ts),
// et `decryptField` est mocké identité (le chiffrement réel est testé dans
// server/_core/crypto.test.ts). `nameSearchKey` reste la VRAIE implémentation
// (fail-open sans ENCRYPTION_KEY en test) : `cle()` ci-dessous en est le miroir.

let fauxPatients: {
  id: number;
  nameSearch: string | null;
  birthDate: string | null;
}[] = [];
let fauxStudies: {
  id: number;
  patientId: number;
  studyDate: string | null;
  modality: string | null;
}[] = [];

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

function fakeDb() {
  return {
    select: () => ({
      from: (table: any) => ({
        where: (_c: any) => ({
          limit: (_n: any) =>
            Promise.resolve(table === patients ? fauxPatients : fauxStudies),
        }),
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

  it("ordre prénom nom (DICOM inversé) reconnu aussi", async () => {
    fauxPatients = [
      { id: 3, nameSearch: cle("marie dupont"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "12.03.1985",
      tel: null,
    });
    expect(r).toMatchObject({ statut: "exact", patientId: 3 });
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

  it("2 patients même nom+DDN ⇒ ambigu", async () => {
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
    expect(r).toMatchObject({ statut: "ambigu", patientId: null });
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

  it("DDN fournie mais ne concordant avec aucun homonyme ⇒ pas exact", async () => {
    fauxPatients = [
      { id: 1, nameSearch: cle("dupont marie"), birthDate: "19850312" },
    ];
    const r = await matchPatient({
      nom: "Dupont",
      prenom: "Marie",
      ddn: "01.01.2000",
      tel: null,
    });
    expect(r.statut).not.toBe("exact");
    expect(r.patientId).toBeNull();
  });

  it("aucune correspondance de nom ⇒ aucun", async () => {
    // Le faux drizzle modélise la RÉPONSE de la requête `where(inArray(...))`,
    // pas le contenu brut de la table : un homonyme absent ⇒ 0 ligne renvoyée.
    fauxPatients = [];
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
});
