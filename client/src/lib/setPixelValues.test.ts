import { describe, it, expect } from "vitest";
import {
  setPixelsInMask,
  setPixelsOutsideMask,
  applyToRoi,
  type RoiPixelOp,
} from "./setPixelValues";

// Fabrique un masque à partir d'un tableau de 0/1 lisible.
const mask = (...bits: number[]): Uint8Array => Uint8Array.from(bits);

describe("setPixelsInMask", () => {
  it("remplace les pixels dans le masque, laisse les autres", () => {
    const pixels = [10, 20, 30, 40];
    const m = mask(1, 0, 1, 0);
    expect(setPixelsInMask(pixels, m, 99)).toEqual([99, 20, 99, 40]);
  });

  it("traite toute valeur de masque ≠ 0 comme « dedans »", () => {
    const pixels = [1, 2, 3];
    const m = mask(0, 255, 7);
    expect(setPixelsInMask(pixels, m, 0)).toEqual([1, 0, 0]);
  });

  it("ne mute ni les pixels ni le masque", () => {
    const pixels = [10, 20, 30];
    const m = mask(1, 1, 1);
    const copyPixels = [...pixels];
    const copyMask = Uint8Array.from(m);
    const out = setPixelsInMask(pixels, m, 5);
    expect(pixels).toEqual(copyPixels);
    expect(m).toEqual(copyMask);
    expect(out).not.toBe(pixels as unknown);
  });

  it("masque tout-à-zéro = recopie identique", () => {
    const pixels = [7, 8, 9];
    expect(setPixelsInMask(pixels, mask(0, 0, 0), 1)).toEqual([7, 8, 9]);
  });

  it("masque tout-à-un = tout remplacé", () => {
    const pixels = [7, 8, 9];
    expect(setPixelsInMask(pixels, mask(1, 1, 1), -3)).toEqual([-3, -3, -3]);
  });

  it("tableaux vides → tableau vide", () => {
    expect(setPixelsInMask([], mask(), 42)).toEqual([]);
  });

  it("gère les valeurs négatives, flottantes et NaN comme valeur de remplissage", () => {
    const pixels = [1, 1, 1];
    const out = setPixelsInMask(pixels, mask(1, 0, 1), NaN);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBe(1);
    expect(out[2]).toBeNaN();
  });

  it("lève si masque et pixels de longueurs différentes", () => {
    expect(() => setPixelsInMask([1, 2, 3], mask(1, 0), 0)).toThrow(
      /longueurs différentes/
    );
  });
});

describe("setPixelsOutsideMask", () => {
  it("remplace les pixels hors masque, laisse ceux dedans", () => {
    const pixels = [10, 20, 30, 40];
    const m = mask(1, 0, 1, 0);
    expect(setPixelsOutsideMask(pixels, m, 99)).toEqual([10, 99, 30, 99]);
  });

  it("est le complément de setPixelsInMask sur le même masque", () => {
    const pixels = [5, 6, 7, 8];
    const m = mask(1, 0, 0, 1);
    const inside = setPixelsInMask(pixels, m, 0);
    const outside = setPixelsOutsideMask(pixels, m, 0);
    // Là où l'un remplace, l'autre conserve, et inversement.
    for (let i = 0; i < pixels.length; i++) {
      if (m[i] !== 0) {
        expect(inside[i]).toBe(0);
        expect(outside[i]).toBe(pixels[i]);
      } else {
        expect(inside[i]).toBe(pixels[i]);
        expect(outside[i]).toBe(0);
      }
    }
  });

  it("masque tout-à-zéro = tout remplacé", () => {
    expect(setPixelsOutsideMask([1, 2, 3], mask(0, 0, 0), 9)).toEqual([
      9, 9, 9,
    ]);
  });

  it("masque tout-à-un = recopie identique", () => {
    expect(setPixelsOutsideMask([1, 2, 3], mask(1, 1, 1), 9)).toEqual([
      1, 2, 3,
    ]);
  });

  it("ne mute pas la source", () => {
    const pixels = [1, 2, 3];
    const copy = [...pixels];
    setPixelsOutsideMask(pixels, mask(1, 0, 1), 0);
    expect(pixels).toEqual(copy);
  });

  it("tableaux vides → tableau vide", () => {
    expect(setPixelsOutsideMask([], mask(), 42)).toEqual([]);
  });

  it("lève si longueurs différentes", () => {
    expect(() => setPixelsOutsideMask([1], mask(1, 1), 0)).toThrow(
      /longueurs différentes/
    );
  });
});

describe("applyToRoi", () => {
  const pixels = [10, 20, 30, 40];
  const m = mask(1, 0, 1, 0);

  it("op « set » équivaut à setPixelsInMask", () => {
    expect(applyToRoi(pixels, m, "set", 99)).toEqual(
      setPixelsInMask(pixels, m, 99)
    );
  });

  it("op « add » additionne dans la ROI, laisse hors ROI", () => {
    expect(applyToRoi(pixels, m, "add", 5)).toEqual([15, 20, 35, 40]);
  });

  it("op « add » avec valeur négative = soustraction", () => {
    expect(applyToRoi(pixels, m, "add", -10)).toEqual([0, 20, 20, 40]);
  });

  it("op « min » plafonne vers le bas dans la ROI", () => {
    // value=25 : 10→min(10,25)=10 ; 30→min(30,25)=25 ; hors ROI inchangés.
    expect(applyToRoi(pixels, m, "min", 25)).toEqual([10, 20, 25, 40]);
  });

  it("op « max » plancher vers le haut dans la ROI", () => {
    // value=25 : 10→max(10,25)=25 ; 30→max(30,25)=30 ; hors ROI inchangés.
    expect(applyToRoi(pixels, m, "max", 25)).toEqual([25, 20, 30, 40]);
  });

  it("masque tout-à-zéro = recopie identique quelle que soit l'op", () => {
    const ops: RoiPixelOp[] = ["set", "add", "min", "max"];
    for (const op of ops) {
      expect(applyToRoi(pixels, mask(0, 0, 0, 0), op, 123)).toEqual(pixels);
    }
  });

  it("masque tout-à-un applique l'op partout", () => {
    expect(applyToRoi([1, 2, 3], mask(1, 1, 1), "add", 1)).toEqual([2, 3, 4]);
  });

  it("ne mute ni pixels ni masque", () => {
    const px = [10, 20, 30, 40];
    const copyPx = [...px];
    const mm = mask(1, 1, 0, 0);
    const copyMm = Uint8Array.from(mm);
    applyToRoi(px, mm, "add", 100);
    expect(px).toEqual(copyPx);
    expect(mm).toEqual(copyMm);
  });

  it("tableaux vides → tableau vide", () => {
    expect(applyToRoi([], mask(), "set", 0)).toEqual([]);
  });

  it("propage NaN/flottants sans planter (add)", () => {
    const out = applyToRoi([1.5, 2.5], mask(1, 1), "add", 0.25);
    expect(out).toEqual([1.75, 2.75]);
  });

  it("min/max gèrent les valeurs négatives", () => {
    expect(applyToRoi([-5, -10], mask(1, 1), "min", -7)).toEqual([-7, -10]);
    expect(applyToRoi([-5, -10], mask(1, 1), "max", -7)).toEqual([-5, -7]);
  });

  it("lève si longueurs différentes", () => {
    expect(() => applyToRoi([1, 2], mask(1), "set", 0)).toThrow(
      /longueurs différentes/
    );
  });

  it("lève sur une opération inconnue", () => {
    // On force une op invalide pour vérifier la garde d'exhaustivité.
    expect(() =>
      applyToRoi([1], mask(1), "mul" as unknown as RoiPixelOp, 2)
    ).toThrow(/Opération ROI inconnue/);
  });
});
