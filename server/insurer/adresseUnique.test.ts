import { describe, it, expect } from "vitest";
import { normaliserAdresseUnique } from "./adresseUnique";

describe("normaliserAdresseUnique", () => {
  it("adresse valide → normalisée en minuscules, trim", () => {
    expect(normaliserAdresseUnique("  Dossier@SUVA.ch ")).toBe(
      "dossier@suva.ch"
    );
  });

  it("null/undefined/vide → null", () => {
    expect(normaliserAdresseUnique(null)).toBeNull();
    expect(normaliserAdresseUnique(undefined)).toBeNull();
    expect(normaliserAdresseUnique("")).toBeNull();
    expect(normaliserAdresseUnique("   ")).toBeNull();
  });

  // Audit C1 : `extraction.adresseReponse` est du texte libre lu dans le
  // corps du mail entrant (non fiable). Un attaquant qui prétend être
  // l'assureur peut y glisser une liste pour se faire mettre en copie du
  // colis DICOM+CR envoyé par `envoyerReponse`.
  it("liste séparée par virgule (smuggling) → null", () => {
    expect(
      normaliserAdresseUnique("attacker@evil.com, dossier@suva.ch")
    ).toBeNull();
  });

  it("liste séparée par point-virgule → null", () => {
    expect(
      normaliserAdresseUnique("attacker@evil.com; dossier@suva.ch")
    ).toBeNull();
  });

  it("liste séparée par espace → null", () => {
    expect(
      normaliserAdresseUnique("attacker@evil.com dossier@suva.ch")
    ).toBeNull();
  });

  it("forme d'affichage avec chevrons → null", () => {
    expect(
      normaliserAdresseUnique("Dossier SUVA <dossier@suva.ch>")
    ).toBeNull();
  });

  it("double @ → null", () => {
    expect(normaliserAdresseUnique("a@evil.com@suva.ch")).toBeNull();
  });

  it("adresse malformée (pas de domaine) → null", () => {
    expect(normaliserAdresseUnique("dossier@suva")).toBeNull();
  });
});
