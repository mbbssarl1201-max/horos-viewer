import { describe, it, expect } from "vitest";
import {
  findPetSeries,
  hasPetSeries,
  clampFusionOpacity,
  petColormapVtkName,
  PET_COLORMAPS,
  DEFAULT_PET_COLORMAP_ID,
  type SeriesLike,
} from "./petFusion";

const series: SeriesLike[] = [
  { id: 1, modality: "CT", seriesDescription: "CT WB" },
  { id: 2, modality: "PT", seriesDescription: "PET AC" },
  { id: 3, modality: "pt", seriesDescription: "PET autre" },
  { id: 4, modality: " CT ", seriesDescription: "CT bis" },
];

describe("findPetSeries", () => {
  it("retourne les séries PT (insensible casse/espaces)", () => {
    const found = findPetSeries(series);
    expect(found.map(s => s.id)).toEqual([2, 3]);
  });
  it("vide si aucune PET", () => {
    expect(findPetSeries([{ id: 1, modality: "CT" }])).toEqual([]);
  });
  it("gère null/undefined", () => {
    expect(findPetSeries(null)).toEqual([]);
    expect(findPetSeries(undefined)).toEqual([]);
  });
});

describe("hasPetSeries", () => {
  it("vrai si au moins une PET", () => {
    expect(hasPetSeries(series)).toBe(true);
  });
  it("faux sinon", () => {
    expect(hasPetSeries([{ id: 1, modality: "MR" }])).toBe(false);
    expect(hasPetSeries(null)).toBe(false);
  });
});

describe("clampFusionOpacity", () => {
  it("borne dans [0,1]", () => {
    expect(clampFusionOpacity(0.5)).toBe(0.5);
    expect(clampFusionOpacity(0)).toBe(0);
    expect(clampFusionOpacity(1)).toBe(1);
  });
  it("borne les négatifs à 0", () => {
    expect(clampFusionOpacity(-1)).toBe(0);
  });
  it("traite >1 comme un pourcentage", () => {
    expect(clampFusionOpacity(2)).toBe(0.02);
    expect(clampFusionOpacity(50)).toBe(0.5);
    expect(clampFusionOpacity(100)).toBe(1);
    expect(clampFusionOpacity(150)).toBe(1);
  });
  it("entrée non finie → 0", () => {
    expect(clampFusionOpacity(NaN)).toBe(0);
    expect(clampFusionOpacity(Infinity)).toBe(0); // non finie → sûr : 0
  });
});

describe("petColormapVtkName", () => {
  it("résout les ids connus", () => {
    expect(petColormapVtkName("hot")).toBe("2hot");
    expect(petColormapVtkName("inferno")).toBe("Inferno (matplotlib)");
  });
  it("repli sur défaut si inconnu", () => {
    expect(petColormapVtkName("xyz")).toBe(PET_COLORMAPS[0].vtkName);
    expect(petColormapVtkName(undefined)).toBe(PET_COLORMAPS[0].vtkName);
  });
  it("le défaut existe dans la liste", () => {
    expect(PET_COLORMAPS.some(c => c.id === DEFAULT_PET_COLORMAP_ID)).toBe(
      true
    );
  });
});
