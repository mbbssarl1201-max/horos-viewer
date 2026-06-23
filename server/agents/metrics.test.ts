import { describe, it, expect } from "vitest";
import { acceptanceRate, sectionsChangedSignificantly } from "./metrics";

describe("métriques agents", () => {
  it("acceptanceRate = % signés sans correction majeure", () => {
    expect(acceptanceRate({ signed: 10, changedMajor: 3 })).toBe(70);
    expect(acceptanceRate({ signed: 0, changedMajor: 0 })).toBe(0);
  });
  it("détecte une correction majeure (diff > seuil)", () => {
    const a = {
      indication: "x",
      technique: "y",
      resultats: "long".repeat(50),
      conclusion: "RAS",
    };
    const b = {
      indication: "x",
      technique: "y",
      resultats: "completement different".repeat(50),
      conclusion: "anomalie majeure",
    };
    expect(sectionsChangedSignificantly(a, a)).toBe(false);
    expect(sectionsChangedSignificantly(a, b)).toBe(true);
  });
});
