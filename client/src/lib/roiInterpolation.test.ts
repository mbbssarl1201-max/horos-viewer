import { describe, it, expect } from "vitest";
import {
  resampleContour,
  interpolateContours,
  type Contour,
  type Point,
} from "./roiInterpolation";

/** Périmètre d'un contour fermé (utilitaire de vérification). */
function perimeter(c: Contour): number {
  let p = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("resampleContour", () => {
  it("produit exactement n points", () => {
    const square: Contour = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(resampleContour(square, 4)).toHaveLength(4);
    expect(resampleContour(square, 12)).toHaveLength(12);
    expect(resampleContour(square, 1)).toHaveLength(1);
  });

  it("démarre au premier point du contour", () => {
    const square: Contour = [
      [2, 3],
      [12, 3],
      [12, 13],
      [2, 13],
    ];
    const r = resampleContour(square, 8);
    expect(r[0][0]).toBeCloseTo(2);
    expect(r[0][1]).toBeCloseTo(3);
  });

  it("espace régulièrement les points (segments égaux sur un carré)", () => {
    const square: Contour = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const r = resampleContour(square, 8); // périmètre 40, pas de 5
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(5);
    }
  });

  it("conserve (approximativement) le périmètre d'un carré ré-échantillonné", () => {
    const square: Contour = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(perimeter(resampleContour(square, 20))).toBeCloseTo(40);
  });

  it("interpole le long des segments (point au milieu d'une arête)", () => {
    const square: Contour = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    // n=8, pas=5 → le 2e point (index 1) est à mi-arête supérieure : (5,0).
    const r = resampleContour(square, 8);
    expect(r[1][0]).toBeCloseTo(5);
    expect(r[1][1]).toBeCloseTo(0);
  });

  it("ne mute pas l'entrée", () => {
    const square: Contour = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const copy = square.map(p => [...p] as Point);
    resampleContour(square, 9);
    expect(square).toEqual(copy);
  });

  describe("cas dégénérés", () => {
    it("n <= 0 → tableau vide", () => {
      const c: Contour = [
        [0, 0],
        [1, 1],
      ];
      expect(resampleContour(c, 0)).toEqual([]);
      expect(resampleContour(c, -3)).toEqual([]);
    });

    it("contour vide → tableau vide quel que soit n", () => {
      expect(resampleContour([], 5)).toEqual([]);
      expect(resampleContour([], 0)).toEqual([]);
    });

    it("un seul point → ce point dupliqué n fois", () => {
      const r = resampleContour([[4, 7]], 3);
      expect(r).toEqual([
        [4, 7],
        [4, 7],
        [4, 7],
      ]);
    });

    it("périmètre nul (points confondus) → premier point dupliqué", () => {
      const c: Contour = [
        [2, 2],
        [2, 2],
        [2, 2],
      ];
      const r = resampleContour(c, 4);
      expect(r).toHaveLength(4);
      for (const p of r) expect(p).toEqual([2, 2]);
    });

    it("ne produit jamais de NaN", () => {
      const c: Contour = [
        [0, 0],
        [3, 4],
      ];
      const r = resampleContour(c, 7);
      for (const p of r) {
        expect(Number.isFinite(p[0])).toBe(true);
        expect(Number.isFinite(p[1])).toBe(true);
      }
    });
  });
});

describe("interpolateContours", () => {
  const squareA: Contour = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  // Même carré translaté de (100, 0).
  const squareB: Contour = [
    [100, 0],
    [110, 0],
    [110, 10],
    [100, 10],
  ];

  it("renvoie exactement `steps` contours intermédiaires", () => {
    expect(interpolateContours(squareA, squareB, 1)).toHaveLength(1);
    expect(interpolateContours(squareA, squareB, 3)).toHaveLength(3);
    expect(interpolateContours(squareA, squareB, 9)).toHaveLength(9);
  });

  it("n'inclut NI A NI B (seulement l'intermédiaire)", () => {
    const [mid] = interpolateContours(squareA, squareB, 1); // t = 1/2
    // Le contour milieu est translaté de 50 en x.
    for (const p of mid) {
      expect(p[0]).toBeGreaterThanOrEqual(50);
      expect(p[0]).toBeLessThanOrEqual(60);
    }
  });

  it("interpole linéairement aux bonnes fractions", () => {
    // steps=3 → t = 1/4, 2/4, 3/4. Le premier point de A=(0,0), de B=(100,0).
    const res = interpolateContours(squareA, squareB, 3);
    expect(res[0][0][0]).toBeCloseTo(25);
    expect(res[1][0][0]).toBeCloseTo(50);
    expect(res[2][0][0]).toBeCloseTo(75);
  });

  it("chaque contour a un nombre commun de points (max des deux)", () => {
    const triangle: Contour = [
      [0, 0],
      [10, 0],
      [5, 10],
    ];
    const res = interpolateContours(triangle, squareB, 2);
    for (const c of res) {
      expect(c).toHaveLength(4); // max(3, 4)
    }
  });

  it("interpole correctement entre tailles différentes (centre conservé)", () => {
    const triangle: Contour = [
      [0, 0],
      [12, 0],
      [6, 12],
    ];
    // À t très proche de A, le contour interpolé reste proche du triangle.
    const [mid] = interpolateContours(triangle, triangle, 1);
    // A == B → l'intermédiaire est identique (ré-échantillonné) à A.
    expect(perimeter(mid)).toBeCloseTo(perimeter(resampleContour(triangle, 3)));
  });

  it("A == B → contours intermédiaires égaux au ré-échantillonnage commun", () => {
    const res = interpolateContours(squareA, squareA, 2);
    const ref = resampleContour(squareA, 4);
    for (const c of res) {
      for (let k = 0; k < c.length; k++) {
        expect(close(c[k][0], ref[k][0])).toBe(true);
        expect(close(c[k][1], ref[k][1])).toBe(true);
      }
    }
  });

  it("ne mute pas les entrées", () => {
    const a = squareA.map(p => [...p] as Point);
    const b = squareB.map(p => [...p] as Point);
    interpolateContours(squareA, squareB, 4);
    expect(squareA).toEqual(a);
    expect(squareB).toEqual(b);
  });

  describe("cas dégénérés", () => {
    it("steps <= 0 → tableau vide", () => {
      expect(interpolateContours(squareA, squareB, 0)).toEqual([]);
      expect(interpolateContours(squareA, squareB, -2)).toEqual([]);
    });

    it("A et B tous deux vides → `steps` contours vides", () => {
      const res = interpolateContours([], [], 3);
      expect(res).toHaveLength(3);
      for (const c of res) expect(c).toEqual([]);
    });

    it("A vide, B non vide → duplique B aux positions interpolées", () => {
      const res = interpolateContours([], squareB, 2);
      expect(res).toHaveLength(2);
      const ref = resampleContour(squareB, 4);
      for (const c of res) {
        expect(c).toHaveLength(4);
        for (let k = 0; k < c.length; k++) {
          expect(close(c[k][0], ref[k][0])).toBe(true);
          expect(close(c[k][1], ref[k][1])).toBe(true);
        }
      }
    });

    it("B vide, A non vide → duplique A aux positions interpolées", () => {
      const res = interpolateContours(squareA, [], 2);
      const ref = resampleContour(squareA, 4);
      for (const c of res) {
        for (let k = 0; k < c.length; k++) {
          expect(close(c[k][0], ref[k][0])).toBe(true);
          expect(close(c[k][1], ref[k][1])).toBe(true);
        }
      }
    });

    it("ne produit jamais de NaN, même avec des points confondus", () => {
      const degenerate: Contour = [
        [5, 5],
        [5, 5],
      ];
      const res = interpolateContours(degenerate, squareB, 3);
      for (const c of res) {
        for (const p of c) {
          expect(Number.isFinite(p[0])).toBe(true);
          expect(Number.isFinite(p[1])).toBe(true);
        }
      }
    });

    it("contours d'un seul point chacun → interpolation du segment A→B", () => {
      const res = interpolateContours([[0, 0]], [[10, 20]], 1); // t=1/2
      expect(res).toHaveLength(1);
      expect(res[0]).toHaveLength(1);
      expect(res[0][0][0]).toBeCloseTo(5);
      expect(res[0][0][1]).toBeCloseTo(10);
    });
  });
});
