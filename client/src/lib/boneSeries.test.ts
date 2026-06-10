import { describe, it, expect } from "vitest";
import { findBoneSeries, BONE_WINDOW } from "./boneSeries";

describe("findBoneSeries", () => {
  it("repère la série osseuse « OS … » et ignore la série cerveau", () => {
    const list = [
      { id: 1, seriesDescription: "Tete Cerveau Vol. Natif 1.0 FC68" },
      { id: 2, seriesDescription: "OS Standard Vol. Natif 1.0 FC30" },
    ];
    expect(findBoneSeries(list)?.id).toBe(2);
  });

  it("reconnaît bone / osseux / knochen", () => {
    expect(
      findBoneSeries([{ id: 5, seriesDescription: "Bone kernel" }])?.id
    ).toBe(5);
    expect(
      findBoneSeries([{ id: 6, seriesDescription: "Crâne osseux" }])?.id
    ).toBe(6);
    expect(
      findBoneSeries([{ id: 7, seriesDescription: "Schädel Knochen" }])?.id
    ).toBe(7);
  });

  it("ne fait pas de faux positif sur une série de tissus mous", () => {
    const list = [
      { id: 1, seriesDescription: "Tete Cerveau FC68" },
      { id: 2, seriesDescription: "Standard soft tissue B30f" },
    ];
    expect(findBoneSeries(list)).toBeUndefined();
  });

  it("undefined si liste vide ou absente", () => {
    expect(findBoneSeries([])).toBeUndefined();
    expect(findBoneSeries(undefined)).toBeUndefined();
  });

  it("fenêtre osseuse = 2000/500", () => {
    expect(BONE_WINDOW).toEqual({ windowCenter: 500, windowWidth: 2000 });
  });
});
