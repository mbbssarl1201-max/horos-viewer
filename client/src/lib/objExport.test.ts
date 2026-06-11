import { describe, it, expect } from "vitest";
import {
  polyDataArraysToObj,
  polyDataArraysStats,
  sampleVolumeTrilinear,
  huToRgb,
  worldToIndex,
} from "./objExport";

describe("polyDataArraysToObj", () => {
  it("sérialise un unique triangle avec des indices 1-basés", () => {
    // 3 points, 1 cellule triangle [3, 0,1,2]
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const polys = new Int32Array([3, 0, 1, 2]);
    const obj = polyDataArraysToObj(points, polys);
    expect(obj).toBe(
      ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n")
    );
  });

  it("triangule un quad (1 cellule de 4 sommets) en 2 triangles via éventail", () => {
    // 4 points formant un carré, 1 cellule quad [4, 0,1,2,3]
    const points = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const polys = [4, 0, 1, 2, 3];
    const obj = polyDataArraysToObj(points, polys);
    const lines = obj.trimEnd().split("\n");
    // 4 sommets + 2 faces (éventail : 0-1-2 et 0-2-3, en 1-basé)
    expect(lines).toEqual([
      "v 0 0 0",
      "v 1 0 0",
      "v 1 1 0",
      "v 0 1 0",
      "f 1 2 3",
      "f 1 3 4",
    ]);
  });

  it("gère deux triangles formant un quad (cas marching-cubes typique)", () => {
    const points = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    // 2 cellules triangle : [3,0,1,2] puis [3,0,2,3]
    const polys = [3, 0, 1, 2, 3, 0, 2, 3];
    const obj = polyDataArraysToObj(points, polys);
    const lines = obj.trimEnd().split("\n");
    expect(lines).toEqual([
      "v 0 0 0",
      "v 1 0 0",
      "v 1 1 0",
      "v 0 1 0",
      "f 1 2 3",
      "f 1 3 4",
    ]);
  });

  it("ignore les cellules dégénérées n<3 (point/segment) sans casser la suite", () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    // cellule segment [2,0,1] ignorée, puis triangle [3,0,1,2]
    const polys = [2, 0, 1, 3, 0, 1, 2];
    const obj = polyDataArraysToObj(points, polys);
    const lines = obj.trimEnd().split("\n");
    expect(lines).toEqual(["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"]);
  });

  it("formate des coordonnées réelles (mm) en flottants compacts", () => {
    const points = new Float32Array([1.5, -2.25, 0, 0, 0, 0, 0, 0, 0]);
    const polys = new Int32Array([3, 0, 1, 2]);
    const obj = polyDataArraysToObj(points, polys);
    expect(obj.split("\n")[0]).toBe("v 1.5 -2.25 0");
  });

  it("s'arrête proprement sur un tableau de cellules tronqué", () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    // bloc tronqué : annonce 3 sommets mais il n'en reste que 2
    const polys = [3, 0, 1];
    const obj = polyDataArraysToObj(points, polys);
    // 3 sommets écrits, aucune face (bloc invalide ignoré)
    expect(obj.trimEnd().split("\n")).toEqual([
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
    ]);
  });
});

describe("polyDataArraysStats", () => {
  it("compte sommets et triangles (triangles directs)", () => {
    const points = new Float32Array(3 * 4); // 4 sommets
    const polys = [3, 0, 1, 2, 3, 0, 2, 3]; // 2 triangles
    expect(polyDataArraysStats(points, polys)).toEqual({
      vertexCount: 4,
      triangleCount: 2,
    });
  });

  it("compte les triangles issus de la triangulation d'un quad", () => {
    const points = new Float32Array(3 * 4);
    const polys = [4, 0, 1, 2, 3]; // 1 quad → 2 triangles
    expect(polyDataArraysStats(points, polys)).toEqual({
      vertexCount: 4,
      triangleCount: 2,
    });
  });
});

describe("polyDataArraysToObj — couleurs et normales", () => {
  it("émet `v x y z r g b` quand des couleurs par sommet sont fournies", () => {
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const polys = new Int32Array([3, 0, 1, 2]);
    const colors = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const obj = polyDataArraysToObj(points, polys, { colors });
    const lines = obj.trimEnd().split("\n");
    expect(lines[0]).toBe("v 0 0 0 1 0 0");
    expect(lines[1]).toBe("v 1 0 0 0 1 0");
    expect(lines[2]).toBe("v 0 1 0 0 0 1");
    expect(lines[3]).toBe("f 1 2 3");
  });

  it("émet `vn` + faces `f v//vn` quand des normales sont fournies", () => {
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const polys = new Int32Array([3, 0, 1, 2]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const obj = polyDataArraysToObj(points, polys, { normals });
    const lines = obj.trimEnd().split("\n");
    expect(lines).toContain("vn 0 0 1");
    expect(lines[lines.length - 1]).toBe("f 1//1 2//2 3//3");
  });

  it("ignore les couleurs de longueur incohérente (repli silencieux)", () => {
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const polys = new Int32Array([3, 0, 1, 2]);
    const colors = new Float32Array([1, 0, 0]); // 1 couleur pour 3 sommets
    const obj = polyDataArraysToObj(points, polys, { colors });
    expect(obj.split("\n")[0]).toBe("v 0 0 0");
  });
});

describe("worldToIndex", () => {
  it("convertit un point monde en index via origine + spacing", () => {
    // origine (10,20,30), spacing (2,2,2) → point (14,24,34) = index (2,2,2)
    expect(worldToIndex([14, 24, 34], [10, 20, 30], [2, 2, 2])).toEqual([
      2, 2, 2,
    ]);
  });

  it("rend 0 sur un axe de spacing nul (pas de division par zéro)", () => {
    // axe x : spacing 0 → 0 ; axe y : (5-0)/1 = 5 ; axe z : 0.
    expect(worldToIndex([5, 5, 0], [0, 0, 0], [0, 1, 1])).toEqual([0, 5, 0]);
  });
});

describe("sampleVolumeTrilinear", () => {
  // Grille 2×2×2, valeurs = index linéaire (0..7).
  const dims: [number, number, number] = [2, 2, 2];
  const scalars = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);

  it("rend la valeur exacte aux positions de voxel", () => {
    expect(sampleVolumeTrilinear(scalars, dims, 0, 0, 0)).toBe(0);
    expect(sampleVolumeTrilinear(scalars, dims, 1, 0, 0)).toBe(1);
    expect(sampleVolumeTrilinear(scalars, dims, 0, 1, 0)).toBe(2);
    expect(sampleVolumeTrilinear(scalars, dims, 1, 1, 1)).toBe(7);
  });

  it("interpole au milieu d'une arête (moyenne des 2 voisins)", () => {
    expect(sampleVolumeTrilinear(scalars, dims, 0.5, 0, 0)).toBeCloseTo(0.5);
  });

  it("interpole au centre du cube (moyenne des 8 voisins)", () => {
    // moyenne de 0..7 = 3.5
    expect(sampleVolumeTrilinear(scalars, dims, 0.5, 0.5, 0.5)).toBeCloseTo(
      3.5
    );
  });

  it("clampe les coordonnées hors-grille sur les bords", () => {
    expect(sampleVolumeTrilinear(scalars, dims, -5, -5, -5)).toBe(0);
    expect(sampleVolumeTrilinear(scalars, dims, 99, 99, 99)).toBe(7);
  });
});

describe("huToRgb", () => {
  it("mappe le centre de la fenêtre à un gris moyen (0.5)", () => {
    const [r, g, b] = huToRgb(500, 500, 2000);
    expect(r).toBeCloseTo(0.5);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.5);
  });

  it("clampe en dessous (noir) et au-dessus (blanc) de la fenêtre", () => {
    expect(huToRgb(-1000, 500, 2000)).toEqual([0, 0, 0]);
    expect(huToRgb(5000, 500, 2000)).toEqual([1, 1, 1]);
  });

  it("évite la division par zéro si WW ≤ 0 (seuil dur)", () => {
    // width replié sur 1 ; hu au centre exact → 0.5
    const [r] = huToRgb(40, 40, 0);
    expect(Number.isFinite(r)).toBe(true);
  });
});
