import { describe, it, expect } from "vitest";
import {
  parseSecondRead,
  buildSecondReadPrompt,
  buildReconcilePrompt,
  parseReconcile,
} from "./doubleLecture";

describe("parseSecondRead", () => {
  it("découpe les 3 sections", () => {
    const r = parseSecondRead(
      "RESULTATS:\nFracture non déplacée du radius distal.\nCONCLUSION:\nFracture radius distal.\nANORMAL: oui",
      "gemini-2.5-pro"
    );
    expect(r).toEqual({
      resultats: "Fracture non déplacée du radius distal.",
      conclusion: "Fracture radius distal.",
      abnormal: true,
      model: "gemini-2.5-pro",
    });
  });

  it("ANORMAL: non → abnormal=false", () => {
    expect(
      parseSecondRead("RESULTATS:\nx\nCONCLUSION:\ny\nANORMAL: non", "m")!
        .abnormal
    ).toBe(false);
  });

  it("ANORMAL absent mais sections présentes → abnormal null", () => {
    expect(
      parseSecondRead("RESULTATS:\nx\nCONCLUSION:\ny", "m")!.abnormal
    ).toBeNull();
  });

  it("tolère la casse et les balises en gras markdown", () => {
    const r = parseSecondRead(
      "**Resultats:**\nRAS.\n**Conclusion:**\nExamen normal.\nAnormal: non",
      "m"
    );
    expect(r!.conclusion).toBe("Examen normal.");
    expect(r!.abnormal).toBe(false);
  });

  it("réponse informe → null", () => {
    expect(parseSecondRead("Je ne peux pas.", "m")).toBeNull();
  });
});

describe("buildSecondReadPrompt", () => {
  it("injecte indication et mesures, exige l'indépendance et le format", () => {
    const p = buildSecondReadPrompt({
      indication: "hernie ?",
      measurements: "foie: 1500 mL",
      modality: "CT",
      totalSlices: 250,
    });
    expect(p.user).toContain("hernie ?");
    expect(p.user).toContain("1500 mL");
    expect(p.user).toContain("CT");
    expect(p.system).toContain("INDÉPENDANTE");
    expect(p.system).toContain("RESULTATS:");
    expect(p.system).toContain("ANORMAL:");
  });

  it("sans options → prompts valides quand même", () => {
    const p = buildSecondReadPrompt({});
    expect(p.system.length).toBeGreaterThan(50);
    expect(p.user.length).toBeGreaterThan(10);
  });
});

describe("réconciliation", () => {
  it("le prompt contient les deux lectures et exige ACCORD:", () => {
    const p = buildReconcilePrompt(
      { resultats: "r1", conclusion: "c1", model: "claude-opus-5" },
      {
        resultats: "r2",
        conclusion: "c2",
        abnormal: true,
        model: "gemini-2.5-pro",
      }
    );
    expect(p.user).toContain("r1");
    expect(p.user).toContain("r2");
    expect(p.user).toContain("claude-opus-5");
    expect(p.user).toContain("gemini-2.5-pro");
    expect(p.system).toContain("ACCORD:");
  });

  it("parseReconcile lit le verdict oui/non", () => {
    expect(parseReconcile("Accord global.\nACCORD: oui")!.agree).toBe(true);
    expect(parseReconcile("Désaccord sur L4-L5.\nACCORD: non")!.agree).toBe(
      false
    );
  });

  it("verdict absent → agree null, section conservée", () => {
    const r = parseReconcile("Analyse comparative.");
    expect(r!.agree).toBeNull();
    expect(r!.section).toBe("Analyse comparative.");
  });

  it("la ligne ACCORD: est retirée de la section affichée", () => {
    const r = parseReconcile("Les lectures concordent.\nACCORD: oui");
    expect(r!.section).toBe("Les lectures concordent.");
  });

  it("texte vide → null", () => {
    expect(parseReconcile("")).toBeNull();
    expect(parseReconcile("  \n ")).toBeNull();
  });
});
