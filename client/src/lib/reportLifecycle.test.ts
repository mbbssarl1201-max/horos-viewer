import { describe, it, expect } from "vitest";
import {
  canEditReport,
  canSignReport,
  canAddAddendum,
  REQUIRED_TO_SIGN,
  validateReportSections,
} from "./reportLifecycle";

describe("canEditReport", () => {
  it("autorise l'édition d'un brouillon", () => {
    expect(canEditReport("draft")).toBe(true);
  });
  it("interdit l'édition d'un compte-rendu signé", () => {
    expect(canEditReport("signed")).toBe(false);
  });
});

describe("canSignReport", () => {
  it("interdit la signature sans conclusion", () => {
    expect(
      canSignReport("draft", {
        indication: "",
        technique: "",
        resultats: "x",
        conclusion: "",
      })
    ).toBe(false);
  });
  it("autorise la signature d'un brouillon avec conclusion", () => {
    expect(
      canSignReport("draft", {
        indication: "",
        technique: "",
        resultats: "",
        conclusion: "RAS",
      })
    ).toBe(true);
  });
  it("interdit de re-signer un compte-rendu déjà signé", () => {
    expect(
      canSignReport("signed", {
        indication: "",
        technique: "",
        resultats: "",
        conclusion: "RAS",
      })
    ).toBe(false);
  });
});

describe("canAddAddendum", () => {
  it("n'autorise les addenda que sur un signé", () => {
    expect(canAddAddendum("signed")).toBe(true);
    expect(canAddAddendum("draft")).toBe(false);
  });
});

describe("validateReportSections", () => {
  it("normalise un objet partiel en 4 chaînes", () => {
    expect(validateReportSections({ resultats: "a" })).toEqual({
      indication: "",
      technique: "",
      resultats: "a",
      conclusion: "",
    });
  });
  it("coupe les valeurs non-chaîne", () => {
    expect(validateReportSections({ conclusion: 42 as any }).conclusion).toBe(
      ""
    );
  });
  it("REQUIRED_TO_SIGN cible la conclusion", () => {
    expect(REQUIRED_TO_SIGN).toContain("conclusion");
  });
});
