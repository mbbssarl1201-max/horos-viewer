import { describe, it, expect } from "vitest";
import { isAllowedRecipient } from "./_core/emailAllowList";

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
