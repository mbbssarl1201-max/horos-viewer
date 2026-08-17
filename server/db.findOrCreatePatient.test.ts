import { describe, it, expect } from "vitest";
import { normaliserDdn, choisirDossierPatient } from "./db";

// Identité patient à l'import : la machine du cabinet attribue des PatientID
// DICOM NON FIABLES (même id pour deux personnes ; ids différents pour une même
// personne). La dédup doit se faire par NOM (nameSearch, déjà filtré) + DATE DE
// NAISSANCE, jamais par le seul PatientID DICOM. `choisirDossierPatient` est le
// cœur PUR : parmi les dossiers de MÊME nom, choisit celui de la bonne DDN.

describe("normaliserDdn", () => {
  it("ne garde que les chiffres", () => {
    expect(normaliserDdn("16.02.1986")).toBe("16021986");
    expect(normaliserDdn("1986-02-16")).toBe("19860216");
    expect(normaliserDdn(null)).toBe("");
    expect(normaliserDdn("")).toBe("");
  });
});

describe("choisirDossierPatient", () => {
  it("DDN exacte parmi les homonymes ⇒ ce dossier", () => {
    const r = choisirDossierPatient(
      [
        { id: 3263, birthDate: null },
        { id: 4956, birthDate: "19860216" },
      ],
      "19860216"
    );
    expect(r).toBe(4956);
  });

  it("DDN concordante (DICOM YYYYMMDD des deux côtés)", () => {
    // À l'import, la DDN vient toujours du DICOM au format YYYYMMDD.
    const r = choisirDossierPatient(
      [{ id: 7, birthDate: "19860216" }],
      "19860216"
    );
    expect(r).toBe(7);
  });

  it("aucun homonyme de la bonne DDN ⇒ null (créer un nouveau dossier)", () => {
    // Collision : le seul dossier de ce nom a une AUTRE DDN → pas le même.
    const r = choisirDossierPatient(
      [{ id: 738, birthDate: "19700101" }],
      "19860216"
    );
    expect(r).toBeNull();
  });

  it("aucun homonyme du tout ⇒ null", () => {
    expect(choisirDossierPatient([], "19860216")).toBeNull();
  });

  it("DDN absente des deux côtés + même nom ⇒ réutilise le dossier sans DDN", () => {
    const r = choisirDossierPatient([{ id: 5, birthDate: null }], null);
    expect(r).toBe(5);
  });

  it("DDN fournie mais le seul dossier n'a PAS de DDN ⇒ null (ne pas fusionner à l'aveugle)", () => {
    // Prudence : un dossier sans DDN pourrait être un homonyme. On crée plutôt
    // un dossier daté ; le matching assureur sait rapprocher ensuite.
    const r = choisirDossierPatient(
      [{ id: 3263, birthDate: null }],
      "19860216"
    );
    expect(r).toBeNull();
  });

  it("priorité à la DDN exacte même si un dossier sans DDN existe aussi", () => {
    const r = choisirDossierPatient(
      [
        { id: 3263, birthDate: null },
        { id: 4956, birthDate: "19860216" },
      ],
      "19860216"
    );
    expect(r).toBe(4956);
  });
});
