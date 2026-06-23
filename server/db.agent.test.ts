import { describe, it, expect } from "vitest";
import { normalizeReferringName } from "./db";

describe("agent helpers — normalisation référent", () => {
  it("normalise casse/espaces/accents pour la clé de recherche", () => {
    expect(normalizeReferringName("  Dr  Éva   SON ")).toBe("dr eva son");
    expect(normalizeReferringName("MARTIN^Jean")).toBe("martin jean");
  });
  it("renvoie une chaîne vide pour une entrée vide", () => {
    expect(normalizeReferringName(undefined)).toBe("");
    expect(normalizeReferringName("")).toBe("");
  });
});
