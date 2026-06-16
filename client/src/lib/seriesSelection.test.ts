import { describe, it, expect } from "vitest";
import { shouldReselectSeries } from "./seriesSelection";

describe("shouldReselectSeries", () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("re-sélectionne quand rien n'est sélectionné et la liste est non vide", () => {
    expect(shouldReselectSeries(null, list)).toBe(true);
    expect(shouldReselectSeries(undefined, list)).toBe(true);
  });

  it("ne re-sélectionne pas quand la série sélectionnée appartient à la liste", () => {
    expect(shouldReselectSeries(2, list)).toBe(false);
  });

  it("re-sélectionne quand la série sélectionnée n'appartient pas à la liste (changement d'étude)", () => {
    expect(shouldReselectSeries(99, list)).toBe(true);
  });

  it("ne re-sélectionne pas quand la liste est vide ou nulle", () => {
    expect(shouldReselectSeries(null, [])).toBe(false);
    expect(shouldReselectSeries(2, [])).toBe(false);
    expect(shouldReselectSeries(null, null)).toBe(false);
    expect(shouldReselectSeries(2, undefined)).toBe(false);
  });
});
