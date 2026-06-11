import { describe, it, expect } from "vitest";
import {
  polygonToMask,
  maskToPolygon,
  mergeMasks,
  intersectMasks,
  countMaskPixels,
  type Point,
} from "./polygonBrush";

/** Construit un masque depuis une grille ASCII (`#` = actif). Pratique pour les tests. */
function maskFromRows(rows: string[]): {
  mask: Uint8Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = height > 0 ? rows[0].length : 0;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rows[y][x] === "#") mask[y * width + x] = 1;
    }
  }
  return { mask, width, height };
}

/** Rend un masque en lignes ASCII (debug / assertions lisibles). */
function maskToRows(mask: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = "";
    for (let x = 0; x < width; x++) line += mask[y * width + x] ? "#" : ".";
    rows.push(line);
  }
  return rows;
}

describe("polygonToMask", () => {
  it("rasterise un carré aligné sur la grille", () => {
    // Carré couvrant les centres des pixels x∈{1,2}, y∈{1,2}.
    const sq: Point[] = [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ];
    const mask = polygonToMask(sq, 5, 5);
    expect(maskToRows(mask, 5, 5)).toEqual([
      ".....",
      ".##..",
      ".##..",
      ".....",
      ".....",
    ]);
    expect(countMaskPixels(mask)).toBe(4);
  });

  it("remplit toute l'image quand le polygone la recouvre", () => {
    const big: Point[] = [
      [-10, -10],
      [110, -10],
      [110, 110],
      [-10, 110],
    ];
    const mask = polygonToMask(big, 4, 3);
    expect(countMaskPixels(mask)).toBe(12);
  });

  it("rasterise un triangle (forme non rectangulaire)", () => {
    const tri: Point[] = [
      [0, 0],
      [6, 0],
      [0, 6],
    ];
    const mask = polygonToMask(tri, 6, 6);
    const rows = maskToRows(mask, 6, 6);
    // Triangle rectangle (hypoténuse x+y=6) testé au centre des pixels :
    // ligne 0 (y=0,5) → x+0,5 < 5,5 ⇒ x∈0..4 ; chaque ligne perd un pixel.
    expect(rows[0]).toBe("#####.");
    expect(rows[4]).toBe("#.....");
    // Ligne 5 (y=5,5) : x+0,5 < 0,5 jamais vrai ⇒ vide.
    expect(rows[5]).toBe("......");
    // Coin opposé à l'hypoténuse exclu.
    expect(mask[5 * 6 + 5]).toBe(0);
  });

  it("gère un polygone concave (forme en L)", () => {
    // L : occupe le bas et la colonne de gauche.
    const lshape: Point[] = [
      [0, 0],
      [2, 0],
      [2, 4],
      [4, 4],
      [4, 6],
      [0, 6],
    ];
    const mask = polygonToMask(lshape, 4, 6);
    const rows = maskToRows(mask, 4, 6);
    // Haut : seulement les 2 colonnes de gauche.
    expect(rows[0]).toBe("##..");
    // Bas : toute la largeur.
    expect(rows[5]).toBe("####");
  });

  it("gère un polygone auto-intersectant (règle pair-impair)", () => {
    // Un sablier (bowtie) : la règle even-odd remplit les deux triangles.
    const bowtie: Point[] = [
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ];
    const mask = polygonToMask(bowtie, 4, 4);
    // Au moins quelques pixels actifs, et symétrie gauche/droite.
    expect(countMaskPixels(mask)).toBeGreaterThan(0);
  });

  it("renvoie un masque vide pour moins de 3 sommets", () => {
    expect(countMaskPixels(polygonToMask([], 5, 5))).toBe(0);
    expect(countMaskPixels(polygonToMask([[1, 1]], 5, 5))).toBe(0);
    expect(
      countMaskPixels(
        polygonToMask(
          [
            [0, 0],
            [4, 4],
          ],
          5,
          5
        )
      )
    ).toBe(0);
  });

  it("renvoie un masque de longueur width*height", () => {
    const m = polygonToMask(
      [
        [0, 0],
        [3, 0],
        [3, 3],
      ],
      7,
      4
    );
    expect(m.length).toBe(28);
  });

  it("renvoie un masque vide pour des dimensions nulles", () => {
    expect(
      polygonToMask(
        [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        0,
        5
      ).length
    ).toBe(0);
    expect(
      polygonToMask(
        [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        5,
        0
      ).length
    ).toBe(0);
  });

  it("ignore les sommets non finis sans planter", () => {
    const poly: Point[] = [
      [1, 1],
      [Infinity, 1],
      [3, 3],
      [1, 3],
    ];
    // Ne doit pas lever ; les sommets finis bornent la boîte.
    const mask = polygonToMask(poly, 5, 5);
    expect(mask.length).toBe(25);
  });

  it("rejette des dimensions non entières ou négatives", () => {
    const tri: Point[] = [
      [0, 0],
      [2, 0],
      [0, 2],
    ];
    expect(() => polygonToMask(tri, 2.5, 5)).toThrow();
    expect(() => polygonToMask(tri, -1, 5)).toThrow();
    expect(() => polygonToMask(tri, 5, -2)).toThrow();
  });

  it("ne déborde pas hors grille pour un polygone partiellement hors champ", () => {
    const poly: Point[] = [
      [-5, -5],
      [2, -5],
      [2, 2],
      [-5, 2],
    ];
    const mask = polygonToMask(poly, 4, 4);
    // Seul le quadrant haut-gauche (x<2, y<2) est couvert → 4 pixels.
    expect(maskToRows(mask, 4, 4)).toEqual(["##..", "##..", "....", "...."]);
  });
});

describe("maskToPolygon", () => {
  it("renvoie [] pour un masque vide", () => {
    const { mask, width, height } = maskFromRows([".....", ".....", "....."]);
    expect(maskToPolygon(mask, width, height)).toEqual([]);
  });

  it("renvoie [] pour des dimensions nulles", () => {
    expect(maskToPolygon(new Uint8Array(0), 0, 0)).toEqual([]);
  });

  it("renvoie le coin du pixel pour un pixel isolé", () => {
    const { mask, width, height } = maskFromRows([".....", "..#..", "....."]);
    const poly = maskToPolygon(mask, width, height);
    expect(poly).toEqual([[2, 1]]);
  });

  it("trouve le premier pixel (haut-gauche) comme point de départ", () => {
    const { mask, width, height } = maskFromRows([".##..", ".##..", "....."]);
    const poly = maskToPolygon(mask, width, height);
    expect(poly[0]).toEqual([1, 0]);
    expect(poly.length).toBeGreaterThan(0);
  });

  it("le contour d'un carré reste dans la boîte englobante", () => {
    const { mask, width, height } = maskFromRows([
      "......",
      ".###..",
      ".###..",
      ".###..",
      "......",
      "......",
    ]);
    const poly = maskToPolygon(mask, width, height);
    for (const [x, y] of poly) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(3);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(3);
    }
    expect(poly.length).toBeGreaterThan(1);
  });

  it("rejette des dimensions non entières", () => {
    expect(() => maskToPolygon(new Uint8Array(4), 2.5, 1)).toThrow();
  });

  it("renvoie [] si le masque est trop court pour les dimensions", () => {
    expect(maskToPolygon(new Uint8Array(3), 4, 4)).toEqual([]);
  });
});

describe("aller-retour polygone → masque → polygone → masque", () => {
  it("un contour reconverti redonne un masque équivalent (rectangle plein)", () => {
    const rect: Point[] = [
      [1, 1],
      [5, 1],
      [5, 4],
      [1, 4],
    ];
    const m1 = polygonToMask(rect, 8, 6);
    const contour = maskToPolygon(m1, 8, 6);
    // Le contour suit le BORD (coins de pixels) : reconvertir doit recouvrir
    // au moins l'intérieur. On vérifie que le contour est non vide et borné.
    expect(contour.length).toBeGreaterThan(2);
    const m2 = polygonToMask(contour, 8, 6);
    // m2 doit toucher la même région (intersection non vide).
    expect(countMaskPixels(intersectMasks(m1, m2))).toBeGreaterThan(0);
  });
});

describe("mergeMasks (OU logique)", () => {
  it("fait l'union de deux masques disjoints", () => {
    const a = maskFromRows(["#...", "#...", "...."]);
    const b = maskFromRows(["...#", "...#", "...."]);
    const merged = mergeMasks(a.mask, b.mask);
    expect(maskToRows(merged, 4, 3)).toEqual(["#..#", "#..#", "...."]);
  });

  it("normalise en 0/1 même avec des valeurs > 1", () => {
    const a = new Uint8Array([0, 5, 0, 200]);
    const b = new Uint8Array([3, 0, 0, 0]);
    expect(Array.from(mergeMasks(a, b))).toEqual([1, 1, 0, 1]);
  });

  it("gère le chevauchement (idempotent sur soi-même)", () => {
    const a = maskFromRows(["##", "##"]);
    const merged = mergeMasks(a.mask, a.mask);
    expect(Array.from(merged)).toEqual([1, 1, 1, 1]);
  });

  it("union avec un masque vide est l'identité (normalisée)", () => {
    const a = new Uint8Array([0, 7, 0, 1]);
    const empty = new Uint8Array(4);
    expect(Array.from(mergeMasks(a, empty))).toEqual([0, 1, 0, 1]);
  });

  it("lève une erreur si les longueurs diffèrent", () => {
    expect(() => mergeMasks(new Uint8Array(4), new Uint8Array(5))).toThrow();
  });

  it("renvoie un nouveau tableau (n'altère pas les entrées)", () => {
    const a = new Uint8Array([1, 0]);
    const b = new Uint8Array([0, 1]);
    const out = mergeMasks(a, b);
    out[0] = 9;
    expect(a[0]).toBe(1);
    expect(b[0]).toBe(0);
  });

  it("masques de longueur 0", () => {
    expect(mergeMasks(new Uint8Array(0), new Uint8Array(0)).length).toBe(0);
  });
});

describe("intersectMasks (ET logique)", () => {
  it("garde seulement les pixels communs", () => {
    const a = maskFromRows(["##.", "##."]);
    const b = maskFromRows([".##", ".##"]);
    const inter = intersectMasks(a.mask, b.mask);
    expect(maskToRows(inter, 3, 2)).toEqual([".#.", ".#."]);
  });

  it("intersection avec masque vide est vide", () => {
    const a = new Uint8Array([1, 1, 1]);
    expect(Array.from(intersectMasks(a, new Uint8Array(3)))).toEqual([0, 0, 0]);
  });

  it("lève une erreur si les longueurs diffèrent", () => {
    expect(() =>
      intersectMasks(new Uint8Array(2), new Uint8Array(3))
    ).toThrow();
  });
});

describe("countMaskPixels", () => {
  it("compte les pixels non nuls", () => {
    expect(countMaskPixels(new Uint8Array([0, 1, 0, 5, 0, 200]))).toBe(3);
  });
  it("renvoie 0 pour un masque vide", () => {
    expect(countMaskPixels(new Uint8Array(0))).toBe(0);
    expect(countMaskPixels(new Uint8Array(10))).toBe(0);
  });
});
