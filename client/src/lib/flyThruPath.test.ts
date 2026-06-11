import { describe, it, expect } from "vitest";
import {
  catmullRomSpline,
  pathTangents,
  pathLength,
  type Point3,
} from "./flyThruPath";

/** Distance euclidienne (helper de test). */
function d(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("catmullRomSpline — cas dégénérés", () => {
  it("renvoie [] pour aucun point", () => {
    expect(catmullRomSpline([], 10)).toEqual([]);
  });

  it("renvoie le point unique tel quel", () => {
    expect(catmullRomSpline([[1, 2, 3]], 10)).toEqual([[1, 2, 3]]);
  });

  it("ne mute pas le tableau d'entrée (copie défensive)", () => {
    const pts: Point3[] = [[1, 2, 3]];
    const out = catmullRomSpline(pts, 5);
    out[0][0] = 999;
    expect(pts[0][0]).toBe(1);
  });

  it("samplesPerSegment < 1 est borné à 1 intervalle", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    // 1 segment, 1 intervalle → 2 points (début + fin).
    expect(catmullRomSpline(pts, 0)).toHaveLength(2);
    expect(catmullRomSpline(pts, -3)).toHaveLength(2);
  });

  it("samplesPerSegment fractionnaire est arrondi vers le bas", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    // floor(2.9) = 2 intervalles → 3 points.
    expect(catmullRomSpline(pts, 2.9)).toHaveLength(3);
  });
});

describe("catmullRomSpline — interpolation des points de contrôle", () => {
  it("passe exactement par chaque point de contrôle (4 points)", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 2, 0],
      [3, 2, 1],
      [4, 0, 2],
    ];
    const path = catmullRomSpline(pts, 8);
    // Le premier et le dernier échantillon sont les points terminaux.
    expect(path[0]).toEqual([0, 0, 0]);
    expect(path[path.length - 1]).toEqual([4, 0, 2]);
    // Chaque point de contrôle doit apparaître dans le chemin (à epsilon près).
    for (const cp of pts) {
      const found = path.some(p => d(p, cp) < 1e-9);
      expect(found).toBe(true);
    }
  });

  it("nombre d'échantillons attendu : (segments × steps) + 1", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    const steps = 5;
    const path = catmullRomSpline(pts, steps);
    // 3 segments × 5 + 1 = 16.
    expect(path).toHaveLength(3 * steps + 1);
  });

  it("aucun doublon aux jonctions de segments", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
      [3, 1, 0],
    ];
    const path = catmullRomSpline(pts, 4);
    for (let i = 1; i < path.length; i++) {
      // Deux échantillons consécutifs ne sont jamais identiques ici.
      expect(d(path[i], path[i - 1])).toBeGreaterThan(0);
    }
  });

  it("sur des points colinéaires, la courbe reste sur la droite", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    const path = catmullRomSpline(pts, 6);
    for (const p of path) {
      expect(p[1]).toBeCloseTo(0, 9);
      expect(p[2]).toBeCloseTo(0, 9);
      // x croît dans [0, 3].
      expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(p[0]).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it("x est monotone croissant sur une trajectoire monotone", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [1, 1, 0],
      [2, 1, 0],
      [3, 0, 0],
    ];
    const path = catmullRomSpline(pts, 10);
    for (let i = 1; i < path.length; i++) {
      expect(path[i][0]).toBeGreaterThan(path[i - 1][0]);
    }
  });

  it("gère 2 points (segment simple)", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const path = catmullRomSpline(pts, 4);
    expect(path).toHaveLength(5);
    expect(path[0]).toEqual([0, 0, 0]);
    expect(path[4]).toEqual([10, 0, 0]);
    // Mi-parcours = milieu géométrique (segment unique extrémités dupliquées).
    expect(path[2][0]).toBeCloseTo(5, 9);
  });
});

describe("catmullRomSpline — continuité (C0/C1) sur 4 points", () => {
  const pts: Point3[] = [
    [0, 0, 0],
    [2, 3, 1],
    [5, 1, 4],
    [7, 4, 2],
  ];

  it("C0 : pas de saut — les pas entre échantillons restent petits et réguliers", () => {
    const path = catmullRomSpline(pts, 50);
    const steps: number[] = [];
    for (let i = 1; i < path.length; i++) steps.push(d(path[i], path[i - 1]));
    const maxStep = Math.max(...steps);
    const minStep = Math.min(...steps);
    // Aucune cassure : le plus grand pas reste du même ordre que le plus petit.
    expect(maxStep).toBeLessThan(minStep * 6);
    // Et la longueur d'arc cumulée approche la longueur de la polyligne (≥ corde).
    expect(pathLength(path)).toBeGreaterThanOrEqual(pathLength(pts) - 1e-9);
  });

  it("C1 : la direction de marche ne s'inverse jamais brutalement", () => {
    const path = catmullRomSpline(pts, 100);
    // Produit scalaire normalisé entre deux pas consécutifs > 0 (angle < 90°).
    for (let i = 2; i < path.length; i++) {
      const a: Point3 = [
        path[i - 1][0] - path[i - 2][0],
        path[i - 1][1] - path[i - 2][1],
        path[i - 1][2] - path[i - 2][2],
      ];
      const b: Point3 = [
        path[i][0] - path[i - 1][0],
        path[i][1] - path[i - 1][1],
        path[i][2] - path[i - 1][2],
      ];
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("converge : densifier l'échantillonnage augmente la longueur vers une limite", () => {
    const l10 = pathLength(catmullRomSpline(pts, 10));
    const l100 = pathLength(catmullRomSpline(pts, 100));
    const l1000 = pathLength(catmullRomSpline(pts, 1000));
    expect(l100).toBeGreaterThanOrEqual(l10 - 1e-9);
    expect(l1000).toBeGreaterThanOrEqual(l100 - 1e-9);
    // L'incrément décroît (convergence).
    expect(l1000 - l100).toBeLessThan(l100 - l10 + 1e-6);
  });
});

describe("pathTangents", () => {
  it("renvoie [] pour un chemin vide", () => {
    expect(pathTangents([])).toEqual([]);
  });

  it("renvoie [0,0,0] pour un point unique (aucune direction)", () => {
    expect(pathTangents([[1, 2, 3]])).toEqual([[0, 0, 0]]);
  });

  it("une tangente par point", () => {
    const path: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    expect(pathTangents(path)).toHaveLength(3);
  });

  it("tangentes unitaires sur une droite (toutes vers +x)", () => {
    const path: Point3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ];
    const tans = pathTangents(path);
    for (const t of tans) {
      expect(Math.hypot(t[0], t[1], t[2])).toBeCloseTo(1, 9);
      expect(t[0]).toBeCloseTo(1, 9);
      expect(t[1]).toBeCloseTo(0, 9);
      expect(t[2]).toBeCloseTo(0, 9);
    }
  });

  it("différences avant/arrière aux bords, centrée au milieu", () => {
    const path: Point3[] = [
      [0, 0, 0],
      [0, 2, 0],
      [0, 2, 2],
    ];
    const tans = pathTangents(path);
    // Bord 0 : avant = (0,2,0) normalisé → (0,1,0).
    expect(tans[0]).toEqual([0, 1, 0]);
    // Milieu : centrée = (0,2,2) − (0,0,0) = (0,2,2) normalisé.
    const inv = 1 / Math.SQRT2;
    expect(tans[1][1]).toBeCloseTo(inv, 9);
    expect(tans[1][2]).toBeCloseTo(inv, 9);
    // Bord 2 : arrière = (0,0,2) normalisé → (0,0,1).
    expect(tans[2]).toEqual([0, 0, 1]);
  });

  it("vecteur nul là où deux points voisins coïncident", () => {
    const path: Point3[] = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    const tans = pathTangents(path);
    expect(tans[0]).toEqual([0, 0, 0]);
    expect(tans[1]).toEqual([0, 0, 0]);
  });
});

describe("pathLength", () => {
  it("0 pour aucun point", () => {
    expect(pathLength([])).toBe(0);
  });

  it("0 pour un point unique", () => {
    expect(pathLength([[5, 5, 5]])).toBe(0);
  });

  it("distance simple entre deux points", () => {
    expect(
      pathLength([
        [0, 0, 0],
        [3, 4, 0],
      ])
    ).toBeCloseTo(5, 9);
  });

  it("somme des distances sur une polyligne (4 points)", () => {
    const pts: Point3[] = [
      [0, 0, 0],
      [0, 0, 3],
      [0, 4, 3],
      [0, 4, 3],
    ];
    // 3 + 4 + 0 = 7.
    expect(pathLength(pts)).toBeCloseTo(7, 9);
  });

  it("invariante par translation", () => {
    const a: Point3[] = [
      [0, 0, 0],
      [1, 2, 2],
      [4, 6, 6],
    ];
    const b: Point3[] = a.map(p => [p[0] + 10, p[1] - 5, p[2] + 1] as Point3);
    expect(pathLength(a)).toBeCloseTo(pathLength(b), 9);
  });
});
