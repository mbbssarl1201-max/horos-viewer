import { describe, it, expect } from "vitest";
import {
  buildVertexAdjacency,
  taubinSmooth,
  computeVertexNormals,
} from "./meshSmooth";

describe("buildVertexAdjacency", () => {
  it("quad en 2 triangles : voisinages attendus", () => {
    // Sommets 0,1,2,3 ; triangles (0,1,2) et (0,2,3) → arête diagonale 0–2.
    const polys = [3, 0, 1, 2, 3, 0, 2, 3];
    const adj = buildVertexAdjacency(polys, 4);
    expect([...adj[0]].sort()).toEqual([1, 2, 3]);
    expect([...adj[1]].sort()).toEqual([0, 2]);
    expect([...adj[2]].sort()).toEqual([0, 1, 3]);
    expect([...adj[3]].sort()).toEqual([0, 2]);
  });
});

describe("taubinSmooth", () => {
  it("ne mute pas l'entrée et renvoie un nouveau tableau", () => {
    const pts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const orig = [...pts];
    const adj = buildVertexAdjacency([3, 0, 1, 2], 3);
    const out = taubinSmooth(pts, adj, { iterations: 3 });
    expect(out).toBeInstanceOf(Float32Array);
    expect(pts).toEqual(orig); // entrée intacte
  });

  it("est ~stable sur une grille plane (z reste ≈ 0)", () => {
    // Grille 3×3 dans le plan z=0.
    const points: number[] = [];
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) points.push(x, y, 0);
    const idx = (x: number, y: number) => y * 3 + x;
    const polys: number[] = [];
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        polys.push(3, idx(x, y), idx(x + 1, y), idx(x + 1, y + 1));
        polys.push(3, idx(x, y), idx(x + 1, y + 1), idx(x, y + 1));
      }
    const adj = buildVertexAdjacency(polys, 9);
    const out = taubinSmooth(points, adj, { iterations: 10 });
    for (let v = 0; v < 9; v++) {
      // La géométrie plane reste plane (z proche de 0).
      expect(Math.abs(out[v * 3 + 2])).toBeLessThan(1e-3);
    }
  });

  it("rapproche un sommet hors-plan du plan de ses voisins", () => {
    // Sommet central (4) hors plan (z=1), entouré d'une grille z=0.
    const points: number[] = [];
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) points.push(x, y, x === 1 && y === 1 ? 1 : 0);
    const idx = (x: number, y: number) => y * 3 + x;
    const polys: number[] = [];
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        polys.push(3, idx(x, y), idx(x + 1, y), idx(x + 1, y + 1));
        polys.push(3, idx(x, y), idx(x + 1, y + 1), idx(x, y + 1));
      }
    const adj = buildVertexAdjacency(polys, 9);
    const out = taubinSmooth(points, adj, { iterations: 10 });
    // Le z du sommet central diminue nettement (vers le plan des voisins).
    expect(out[4 * 3 + 2]).toBeLessThan(1);
    expect(out[4 * 3 + 2]).toBeGreaterThanOrEqual(0);
  });
});

describe("computeVertexNormals", () => {
  it("triangle dans le plan z=0 → normale ≈ (0,0,±1) unitaire", () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const polys = [3, 0, 1, 2];
    const normals = computeVertexNormals(points, polys);
    for (let v = 0; v < 3; v++) {
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      expect(Math.abs(nx)).toBeLessThan(1e-6);
      expect(Math.abs(ny)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(nz) - 1)).toBeLessThan(1e-6); // unitaire ±1
    }
  });
});
