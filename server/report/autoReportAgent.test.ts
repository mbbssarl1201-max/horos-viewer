import { describe, it, expect } from "vitest";
import { computeBatchSize } from "./autoReportAgent";

describe("agent — taille de lot (plafond/jour)", () => {
  it("limite par le plafond restant du jour", () => {
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 18 })).toBe(2);
  });
  it("zéro si plafond atteint", () => {
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 20 })).toBe(0);
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 25 })).toBe(0);
  });
  it("ne dépasse jamais le plafond de sécurité par passe (10)", () => {
    expect(computeBatchSize({ dailyCap: 1000, generatedToday: 0 })).toBe(10);
  });
});
