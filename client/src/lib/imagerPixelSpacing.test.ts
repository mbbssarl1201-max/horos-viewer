import { describe, it, expect } from "vitest";
import { patchImagerPixelSpacing } from "./imagerPixelSpacing";

// Module imagePlaneModule tel que renvoyé par le loader Cornerstone.
// `usingDefaultValues: true` signifie que le DICOM n'avait PAS de PixelSpacing
// (0028,0030) : le loader a posé rowPixelSpacing = columnPixelSpacing = 1.
const moduleWithoutSpacing = {
  rows: 2140,
  columns: 1760,
  rowPixelSpacing: 1,
  columnPixelSpacing: 1,
  pixelSpacing: undefined,
  usingDefaultValues: true,
  frameOfReferenceUID: "1.2.3",
};

describe("patchImagerPixelSpacing", () => {
  it("remplace le spacing par défaut (1 px) par l'ImagerPixelSpacing réel", () => {
    const out = patchImagerPixelSpacing(moduleWithoutSpacing, [0.143, 0.143]);
    expect(out).toBeDefined();
    expect(out!.rowPixelSpacing).toBe(0.143);
    expect(out!.columnPixelSpacing).toBe(0.143);
    expect(out!.pixelSpacing).toEqual([0.143, 0.143]);
    expect(out!.usingDefaultValues).toBe(false);
    // les autres champs du module sont préservés
    expect(out!.rows).toBe(2140);
    expect(out!.frameOfReferenceUID).toBe("1.2.3");
  });

  it("gère un spacing anisotrope (lignes ≠ colonnes)", () => {
    const out = patchImagerPixelSpacing(moduleWithoutSpacing, [0.2, 0.25]);
    expect(out!.rowPixelSpacing).toBe(0.2);
    expect(out!.columnPixelSpacing).toBe(0.25);
  });

  it("ne touche RIEN si le module a déjà un vrai PixelSpacing (usingDefaultValues=false)", () => {
    const realModule = {
      ...moduleWithoutSpacing,
      rowPixelSpacing: 0.5,
      columnPixelSpacing: 0.5,
      usingDefaultValues: false,
    };
    expect(patchImagerPixelSpacing(realModule, [0.143, 0.143])).toBeUndefined();
  });

  it("ne patche pas si l'ImagerPixelSpacing est absent", () => {
    expect(
      patchImagerPixelSpacing(moduleWithoutSpacing, undefined)
    ).toBeUndefined();
    expect(patchImagerPixelSpacing(moduleWithoutSpacing, null)).toBeUndefined();
  });

  it("ne patche pas si l'ImagerPixelSpacing est incomplet ou non positif", () => {
    expect(
      patchImagerPixelSpacing(moduleWithoutSpacing, [0.143])
    ).toBeUndefined();
    expect(
      patchImagerPixelSpacing(moduleWithoutSpacing, [0, 0.143])
    ).toBeUndefined();
    expect(
      patchImagerPixelSpacing(moduleWithoutSpacing, [-0.1, 0.143])
    ).toBeUndefined();
    expect(
      patchImagerPixelSpacing(moduleWithoutSpacing, [NaN, 0.143])
    ).toBeUndefined();
  });

  it("ne patche pas un module absent", () => {
    expect(patchImagerPixelSpacing(undefined, [0.143, 0.143])).toBeUndefined();
    expect(patchImagerPixelSpacing(null, [0.143, 0.143])).toBeUndefined();
  });
});
