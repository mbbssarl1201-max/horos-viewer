import { describe, it, expect } from "vitest";
import {
  polygonArea,
  polygonPerimeter,
  stackVolume,
  type Point,
  type PixelSpacing,
} from "./roiVolume";

const UNIT: PixelSpacing = [1, 1]; // 1 mm/pixel sur les deux axes

describe("polygonArea", () => {
  it("carré 10×10 px à 1 mm/px → 100 mm²", () => {
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonArea(sq, UNIT)).toBeCloseTo(100, 9);
  });

  it("triangle rectangle base 4 hauteur 6 → 12 mm²", () => {
    const tri: Point[] = [
      [0, 0],
      [4, 0],
      [0, 6],
    ];
    expect(polygonArea(tri, UNIT)).toBeCloseTo(12, 9);
  });

  it("applique le PixelSpacing anisotrope [row, col]", () => {
    // carré de 10×10 px, spacing row=0.5, col=2 → 20mm × 5mm = 100 mm²
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonArea(sq, [0.5, 2])).toBeCloseTo(100, 9);
  });

  it("orientation horaire et antihoraire donnent la même aire positive", () => {
    const ccw: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const cw: Point[] = [...ccw].reverse();
    expect(polygonArea(cw, UNIT)).toBeCloseTo(polygonArea(ccw, UNIT), 9);
    expect(polygonArea(cw, UNIT)).toBeGreaterThan(0);
  });

  it("polygone concave (forme en L) calculé correctement", () => {
    // L : 3x3 carré moins le coin 1x1 supérieur droit → 8 mm²
    const lshape: Point[] = [
      [0, 0],
      [3, 0],
      [3, 2],
      [2, 2],
      [2, 3],
      [0, 3],
    ];
    expect(polygonArea(lshape, UNIT)).toBeCloseTo(8, 9);
  });

  it("polygone fermé explicitement (dernier = premier) → même aire", () => {
    const open: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const closed: Point[] = [...open, [0, 0]];
    // le sommet doublé ajoute une arête de longueur nulle → aire inchangée
    expect(polygonArea(closed, UNIT)).toBeCloseTo(100, 9);
  });

  // ── Cas dégénérés ──────────────────────────────────────────────
  it("moins de 3 sommets → 0", () => {
    expect(polygonArea([], UNIT)).toBe(0);
    expect(polygonArea([[0, 0]], UNIT)).toBe(0);
    expect(
      polygonArea(
        [
          [0, 0],
          [1, 1],
        ],
        UNIT
      )
    ).toBe(0);
  });

  it("polygone aplati (sommets colinéaires) → 0", () => {
    const flat: Point[] = [
      [0, 0],
      [5, 0],
      [10, 0],
    ];
    expect(polygonArea(flat, UNIT)).toBe(0);
  });

  it("spacing nul, négatif ou non fini → 0", () => {
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonArea(sq, [0, 1])).toBe(0);
    expect(polygonArea(sq, [1, 0])).toBe(0);
    expect(polygonArea(sq, [-1, 1])).toBe(0);
    expect(polygonArea(sq, [Number.NaN, 1])).toBe(0);
    expect(polygonArea(sq, [1, Infinity])).toBe(0);
  });

  it("sommet non fini → 0 (pas de NaN propagé)", () => {
    const bad: Point[] = [
      [0, 0],
      [Number.NaN, 0],
      [10, 10],
    ];
    expect(polygonArea(bad, UNIT)).toBe(0);
    const bad2: Point[] = [
      [0, 0],
      [10, 0],
      [10, Infinity],
    ];
    expect(polygonArea(bad2, UNIT)).toBe(0);
  });
});

describe("polygonPerimeter", () => {
  it("carré 10×10 px à 1 mm/px → 40 mm", () => {
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonPerimeter(sq, UNIT)).toBeCloseTo(40, 9);
  });

  it("triangle 3-4-5 → périmètre 12 mm", () => {
    const tri: Point[] = [
      [0, 0],
      [4, 0],
      [0, 3],
    ];
    // arêtes : 4 + 3 + 5 (hypoténuse) = 12
    expect(polygonPerimeter(tri, UNIT)).toBeCloseTo(12, 9);
  });

  it("applique le PixelSpacing anisotrope [row, col]", () => {
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    // largeur 10px×2 = 20mm (×2 côtés) + hauteur 10px×0.5 = 5mm (×2) = 50
    expect(polygonPerimeter(sq, [0.5, 2])).toBeCloseTo(50, 9);
  });

  it("deux sommets → aller-retour (2× le segment)", () => {
    const seg: Point[] = [
      [0, 0],
      [3, 4],
    ];
    expect(polygonPerimeter(seg, UNIT)).toBeCloseTo(10, 9); // 5 × 2
  });

  // ── Cas dégénérés ──────────────────────────────────────────────
  it("moins de 2 sommets → 0", () => {
    expect(polygonPerimeter([], UNIT)).toBe(0);
    expect(polygonPerimeter([[0, 0]], UNIT)).toBe(0);
  });

  it("spacing invalide → 0", () => {
    const sq: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonPerimeter(sq, [0, 1])).toBe(0);
    expect(polygonPerimeter(sq, [1, -2])).toBe(0);
    expect(polygonPerimeter(sq, [Number.NaN, 1])).toBe(0);
  });

  it("sommet non fini → 0", () => {
    const bad: Point[] = [
      [0, 0],
      [Infinity, 0],
      [10, 10],
    ];
    expect(polygonPerimeter(bad, UNIT)).toBe(0);
  });
});

describe("stackVolume", () => {
  it("somme des surfaces × espacement", () => {
    // 3 coupes de 100 mm², espacement 2 mm → 600 mm³
    expect(stackVolume([100, 100, 100], 2)).toBeCloseTo(600, 9);
  });

  it("surfaces hétérogènes", () => {
    expect(stackVolume([50, 75, 25], 4)).toBeCloseTo((50 + 75 + 25) * 4, 9);
  });

  it("une seule coupe", () => {
    expect(stackVolume([42], 3)).toBeCloseTo(126, 9);
  });

  it("ignore les surfaces non finies ou négatives", () => {
    expect(stackVolume([100, Number.NaN, 100], 1)).toBeCloseTo(200, 9);
    expect(stackVolume([100, -50, 100], 1)).toBeCloseTo(200, 9);
    expect(stackVolume([100, Infinity, 100], 1)).toBeCloseTo(200, 9);
  });

  it("surface nulle ignorée (ne change pas le total)", () => {
    expect(stackVolume([100, 0, 100], 2)).toBeCloseTo(400, 9);
  });

  // ── Cas dégénérés ──────────────────────────────────────────────
  it("liste vide → 0", () => {
    expect(stackVolume([], 5)).toBe(0);
  });

  it("espacement nul, négatif ou non fini → 0", () => {
    expect(stackVolume([100, 100], 0)).toBe(0);
    expect(stackVolume([100, 100], -2)).toBe(0);
    expect(stackVolume([100, 100], Number.NaN)).toBe(0);
    expect(stackVolume([100, 100], Infinity)).toBe(0);
  });

  it("toutes les surfaces invalides → 0", () => {
    expect(stackVolume([Number.NaN, -1, 0], 5)).toBe(0);
  });
});

describe("intégration surface → volume", () => {
  it("ROI carrée constante sur N coupes donne un prisme cohérent", () => {
    const sq: Point[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    const area = polygonArea(sq, UNIT); // 400 mm²
    const areas = [area, area, area, area, area]; // 5 coupes
    expect(stackVolume(areas, 3)).toBeCloseTo(400 * 5 * 3, 9); // 6000 mm³
  });
});
