import { describe, it, expect } from "vitest";
import { assertToolAllowed } from "./tools";

describe("tool-gate", () => {
  it("autorise un outil déclaré dans la fiche", () => {
    expect(() => assertToolAllowed("redacteur", "generateDraft")).not.toThrow();
  });
  it("refuse un outil hors-fiche", () => {
    expect(() => assertToolAllowed("copilote", "generateDraft")).toThrow(
      /non autorisé/i
    );
  });
  it("refuse un agent inconnu", () => {
    expect(() => assertToolAllowed("inconnu", "x")).toThrow(/inconnu/i);
  });
});
