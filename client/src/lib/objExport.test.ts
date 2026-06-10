import { describe, it, expect } from "vitest";
import { polyDataArraysToObj, polyDataArraysStats } from "./objExport";

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
