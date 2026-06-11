import { describe, it, expect } from "vitest";
import { downsampleScalarVolume } from "./volumeDownsample";

describe("downsampleScalarVolume", () => {
  it("facteur 1 : copie fidèle (dims/spacing/origin inchangés)", () => {
    // Volume 2×2×1 : valeurs = index linéaire.
    const scalars = [0, 1, 2, 3];
    const r = downsampleScalarVolume(
      scalars,
      [2, 2, 1],
      [0.5, 0.5, 2],
      [10, 20, 30],
      1
    );
    expect(r.dims).toEqual([2, 2, 1]);
    expect(r.spacing).toEqual([0.5, 0.5, 2]);
    expect(r.origin).toEqual([10, 20, 30]);
    expect(Array.from(r.scalars)).toEqual([0, 1, 2, 3]);
  });

  it("facteur 2 : dims=ceil(dim/2), spacing*2, origin inchangé", () => {
    // Volume 4×4×2 (nx=4, ny=4, nz=2), index = x + y*4 + z*16.
    const nx = 4,
      ny = 4,
      nz = 2;
    const scalars = new Float32Array(nx * ny * nz);
    for (let i = 0; i < scalars.length; i++) scalars[i] = i;
    const r = downsampleScalarVolume(
      scalars,
      [nx, ny, nz],
      [1, 1, 3],
      [0, 0, 0],
      2
    );
    expect(r.dims).toEqual([2, 2, 1]);
    expect(r.spacing).toEqual([2, 2, 6]);
    expect(r.origin).toEqual([0, 0, 0]);
    // Indices source conservés : (x,y,z) ∈ {0,2}×{0,2}×{0}.
    // index = x + y*4 + z*16 → (0,0,0)=0, (2,0,0)=2, (0,2,0)=8, (2,2,0)=10.
    expect(Array.from(r.scalars)).toEqual([0, 2, 8, 10]);
  });

  it("facteur 2 sur dimension impaire : ceil arrondit vers le haut + clamp au bord", () => {
    // nx=3 → ceil(3/2)=2 ; échantillonne x=0 et x=2 (clampé, dernier voxel).
    const scalars = [10, 11, 12]; // 3×1×1
    const r = downsampleScalarVolume(
      scalars,
      [3, 1, 1],
      [1, 1, 1],
      [5, 0, 0],
      2
    );
    expect(r.dims).toEqual([2, 1, 1]);
    expect(Array.from(r.scalars)).toEqual([10, 12]);
  });

  it("facteur 4 : ~1/64 des voxels", () => {
    const nx = 8,
      ny = 8,
      nz = 8;
    const scalars = new Float32Array(nx * ny * nz).fill(7);
    const r = downsampleScalarVolume(
      scalars,
      [nx, ny, nz],
      [1, 1, 1],
      [0, 0, 0],
      4
    );
    expect(r.dims).toEqual([2, 2, 2]);
    expect(r.scalars.length).toBe(8);
  });
});
