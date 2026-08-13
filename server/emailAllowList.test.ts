import { describe, it, expect } from "vitest";
import {
  isAllowedRecipient,
  isAllowedPhiRecipientStrict,
} from "./_core/emailAllowList";

describe("isAllowedRecipient", () => {
  it("liste vide → aucune restriction (true)", () => {
    expect(isAllowedRecipient("dr@exemple.ch", [])).toBe(true);
  });

  it("domaine présent dans la liste → true", () => {
    expect(isAllowedRecipient("dr@hopital.ch", ["hopital.ch"])).toBe(true);
  });

  it("domaine absent de la liste → false", () => {
    expect(isAllowedRecipient("dr@gmail.com", ["hopital.ch"])).toBe(false);
  });

  it("adresse malformée (pas de @) → false", () => {
    expect(isAllowedRecipient("pas-une-adresse", ["hopital.ch"])).toBe(false);
  });

  it("adresse malformée (@ en dernière position) → false", () => {
    expect(isAllowedRecipient("dr@", ["hopital.ch"])).toBe(false);
  });

  it("casse du domaine de l'adresse ignorée (liste normalisée en minuscules)", () => {
    // La liste est fournie déjà normalisée en minuscules (cf. env.ts) ; le
    // helper abaisse la casse du domaine de l'adresse avant comparaison.
    expect(isAllowedRecipient("DR@Hopital.CH", ["hopital.ch"])).toBe(true);
  });
});

describe("isAllowedPhiRecipientStrict (chemin faible confiance : voix Eva)", () => {
  it("PROD + allow-list vide → refuse (fail-closed, pas le fail-open de isAllowedRecipient)", () => {
    expect(isAllowedPhiRecipientStrict("dr@exemple.ch", [], true)).toBe(false);
  });

  it("hors prod + allow-list vide → autorise (comportement de dev inchangé)", () => {
    expect(isAllowedPhiRecipientStrict("dr@exemple.ch", [], false)).toBe(true);
  });

  it("PROD + domaine whitelisté → autorise", () => {
    expect(
      isAllowedPhiRecipientStrict("dr@hopital.ch", ["hopital.ch"], true)
    ).toBe(true);
  });

  it("PROD + domaine hors liste → refuse", () => {
    expect(
      isAllowedPhiRecipientStrict("dr@gmail.com", ["hopital.ch"], true)
    ).toBe(false);
  });

  it("PROD + liste non vide + adresse malformée → refuse", () => {
    expect(
      isAllowedPhiRecipientStrict("pas-une-adresse", ["hopital.ch"], true)
    ).toBe(false);
  });

  // Audit C1 : `extraction.adresseReponse` (agent assureur) est du texte
  // libre attaquant-influençable, transmis à `nodemailer` `to` qui accepte
  // une liste séparée par virgules. Sans cette garde de forme, une chaîne
  // comme "attacker@evil.com, dossier@suva.ch" passerait le contrôle de
  // domaine (basé sur le DERNIER "@") ET partirait vers les deux adresses.
  it("liste séparée par virgule (smuggling) → refuse, même si le dernier segment est whitelisté", () => {
    expect(
      isAllowedPhiRecipientStrict(
        "attacker@evil.com, dossier@suva.ch",
        ["suva.ch"],
        true
      )
    ).toBe(false);
  });

  it("liste séparée par point-virgule → refuse", () => {
    expect(
      isAllowedPhiRecipientStrict(
        "attacker@evil.com; dossier@suva.ch",
        ["suva.ch"],
        true
      )
    ).toBe(false);
  });

  it("liste séparée par espace → refuse", () => {
    expect(
      isAllowedPhiRecipientStrict(
        "attacker@evil.com dossier@suva.ch",
        ["suva.ch"],
        true
      )
    ).toBe(false);
  });

  it('forme d\'affichage avec chevrons ("Nom <a@b.ch>") → refuse', () => {
    expect(
      isAllowedPhiRecipientStrict(
        "Dossier SUVA <dossier@suva.ch>",
        ["suva.ch"],
        true
      )
    ).toBe(false);
  });

  it("double @ → refuse", () => {
    expect(
      isAllowedPhiRecipientStrict("a@evil.com@suva.ch", ["suva.ch"], true)
    ).toBe(false);
  });

  it("adresse unique valide, domaine whitelisté → autorise toujours (pas de régression)", () => {
    expect(
      isAllowedPhiRecipientStrict("dossier@suva.ch", ["suva.ch"], true)
    ).toBe(true);
  });
});
