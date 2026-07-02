import { describe, it, expect } from "vitest";
import { groupByModality, stripPhiLike } from "./learning";

describe("agent apprentissage", () => {
  it("groupByModality applique le seuil (≥3)", () => {
    const items = [
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
    ];
    const g = groupByModality(items, 3);
    expect(g.has("CT")).toBe(true);
    expect(g.has("US")).toBe(false);
  });
  it("stripPhiLike retire nom MAJUSCULE, date, gros nombre ; garde le médical", () => {
    const t =
      "POCINCI ZEHRA née le 24.12.1997 id 1029384 : épaississement zone jonctionnelle 12 mm";
    const c = stripPhiLike(t);
    expect(c).not.toMatch(/POCINCI|ZEHRA/);
    expect(c).not.toMatch(/24\.12\.1997/);
    expect(c).not.toMatch(/1029384/);
    expect(c).toMatch(/zone jonctionnelle 12 mm/);
  });
});
