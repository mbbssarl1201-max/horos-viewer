import { describe, it, expect } from "vitest";
import {
  pointInPolygon,
  clipMaskByPolygon,
  type Polygon2D,
} from "./scissorClip";

// Carré unité [0,10] × [0,10] (sens horaire ou anti-horaire indifférent).
const square: Polygon2D = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

// Triangle rectangle.
const triangle: Polygon2D = [
  [0, 0],
  [10, 0],
  [0, 10],
];

// Polygone non convexe en « L ».
const lShape: Polygon2D = [
  [0, 0],
  [6, 0],
  [6, 2],
  [2, 2],
  [2, 6],
  [0, 6],
];

describe("pointInPolygon — nominal", () => {
  it("détecte un point au centre du carré", () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
  });

  it("détecte un point hors du carré (à droite)", () => {
    expect(pointInPolygon([15, 5], square)).toBe(false);
  });

  it("détecte un point hors du carré (au-dessus)", () => {
    expect(pointInPolygon([5, -1], square)).toBe(false);
  });

  it("détecte un point hors du carré (à gauche)", () => {
    expect(pointInPolygon([-1, 5], square)).toBe(false);
  });

  it("classe correctement l'intérieur du triangle", () => {
    expect(pointInPolygon([2, 2], triangle)).toBe(true);
  });

  it("classe correctement l'extérieur du triangle (au-delà de l'hypoténuse)", () => {
    // Sur la droite x+y=10, le point (8,8) est largement dehors.
    expect(pointInPolygon([8, 8], triangle)).toBe(false);
  });

  it("tolère un polygone explicitement fermé (premier sommet répété)", () => {
    const closed: Polygon2D = [...square, [0, 0]];
    expect(pointInPolygon([5, 5], closed)).toBe(true);
    expect(pointInPolygon([15, 5], closed)).toBe(false);
  });
});

describe("pointInPolygon — non convexe (L)", () => {
  it("point dans la branche horizontale → intérieur", () => {
    expect(pointInPolygon([1, 1], lShape)).toBe(true);
  });

  it("point dans la branche verticale → intérieur", () => {
    expect(pointInPolygon([1, 4], lShape)).toBe(true);
  });

  it("point dans le creux du L → extérieur", () => {
    expect(pointInPolygon([4, 4], lShape)).toBe(false);
  });
});

describe("pointInPolygon — dégénérés", () => {
  it("polygone vide → false", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
  });

  it("polygone à 1 sommet → false", () => {
    expect(pointInPolygon([0, 0], [[1, 1]])).toBe(false);
  });

  it("polygone à 2 sommets (segment) → false", () => {
    expect(
      pointInPolygon(
        [1, 1],
        [
          [0, 0],
          [2, 2],
        ]
      )
    ).toBe(false);
  });

  it("rayon passant par un sommet n'est pas compté en double", () => {
    // py = 0 aligné sur deux sommets du carré ; un point sous le bord bas
    // (juste au-dessus de y=0) doit être dedans, et y=0 pile est ambigu mais
    // ne doit pas déclencher de double comptage faussant l'intérieur.
    expect(pointInPolygon([5, 0.0001], square)).toBe(true);
    // Point à la hauteur d'un sommet mais clairement à droite → dehors.
    expect(pointInPolygon([20, 0], square)).toBe(false);
  });
});

describe("clipMaskByPolygon — nominal", () => {
  it("garde l'intérieur (keepInside=true)", () => {
    const w = 4;
    const h = 4;
    // Polygone couvrant le quart supérieur gauche : [0,2]×[0,2].
    const poly: Polygon2D = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    const mask = clipMaskByPolygon(w, h, poly, true);
    expect(mask.length).toBe(w * h);
    // Centres conservés : (0.5,0.5) et (1.5,0.5) et (0.5,1.5) et (1.5,1.5).
    expect(mask[0 * w + 0]).toBe(1); // (0.5,0.5)
    expect(mask[0 * w + 1]).toBe(1); // (1.5,0.5)
    expect(mask[1 * w + 0]).toBe(1); // (0.5,1.5)
    expect(mask[1 * w + 1]).toBe(1); // (1.5,1.5)
    // Hors zone.
    expect(mask[0 * w + 2]).toBe(0); // (2.5,0.5)
    expect(mask[2 * w + 0]).toBe(0); // (0.5,2.5)
    expect(mask[3 * w + 3]).toBe(0);
  });

  it("garde l'extérieur (keepInside=false) — complément exact", () => {
    const w = 4;
    const h = 4;
    const poly: Polygon2D = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    const inside = clipMaskByPolygon(w, h, poly, true);
    const outside = clipMaskByPolygon(w, h, poly, false);
    expect(outside.length).toBe(inside.length);
    for (let i = 0; i < inside.length; i++) {
      expect(outside[i]).toBe(inside[i] === 1 ? 0 : 1);
    }
  });

  it("ne produit que des 0 et des 1", () => {
    const mask = clipMaskByPolygon(8, 8, square, true);
    for (const v of mask) expect(v === 0 || v === 1).toBe(true);
  });

  it("polygone couvrant toute la grille → tout 1 (keepInside)", () => {
    const w = 3;
    const h = 3;
    const poly: Polygon2D = [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ];
    const mask = clipMaskByPolygon(w, h, poly, true);
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("ordre row-major : index = y*width + x", () => {
    const w = 5;
    const h = 2;
    // Bande verticale x ∈ [2,3] → seule la colonne x=2 a son centre (2.5) dedans.
    const poly: Polygon2D = [
      [2, 0],
      [3, 0],
      [3, 2],
      [2, 2],
    ];
    const mask = clipMaskByPolygon(w, h, poly, true);
    // Ligne 0 et ligne 1, colonne 2 conservées.
    expect(mask[0 * w + 2]).toBe(1);
    expect(mask[1 * w + 2]).toBe(1);
    // Autres colonnes retirées.
    expect(mask[0 * w + 0]).toBe(0);
    expect(mask[0 * w + 3]).toBe(0);
  });
});

describe("clipMaskByPolygon — dégénérés", () => {
  it("width=0 → masque vide", () => {
    expect(clipMaskByPolygon(0, 5, square, true).length).toBe(0);
  });

  it("height=0 → masque vide", () => {
    expect(clipMaskByPolygon(5, 0, square, true).length).toBe(0);
  });

  it("dimensions négatives → masque vide", () => {
    expect(clipMaskByPolygon(-3, 4, square, true).length).toBe(0);
    expect(clipMaskByPolygon(4, -3, square, true).length).toBe(0);
  });

  it("dimensions non entières → masque vide", () => {
    expect(clipMaskByPolygon(3.5, 4, square, true).length).toBe(0);
    expect(clipMaskByPolygon(4, 2.1, square, true).length).toBe(0);
  });

  it("dimensions non finies → masque vide", () => {
    expect(clipMaskByPolygon(Number.NaN, 4, square, true).length).toBe(0);
    expect(
      clipMaskByPolygon(4, Number.POSITIVE_INFINITY, square, true).length
    ).toBe(0);
  });

  it("polygone <3 sommets + keepInside=true → tout 0", () => {
    const mask = clipMaskByPolygon(3, 3, [[1, 1]], true);
    expect(mask.length).toBe(9);
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });

  it("polygone <3 sommets + keepInside=false → tout 1 (rien à retirer)", () => {
    const mask = clipMaskByPolygon(3, 3, [], false);
    expect(mask.length).toBe(9);
    expect(Array.from(mask).every(v => v === 1)).toBe(true);
  });

  it("déterminisme : deux appels identiques donnent le même masque", () => {
    const a = clipMaskByPolygon(6, 6, triangle, true);
    const b = clipMaskByPolygon(6, 6, triangle, true);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
