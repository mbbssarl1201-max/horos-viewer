import { describe, it, expect } from "vitest";
import { pickSampleIndices } from "./aiSampling";

describe("pickSampleIndices", () => {
  it("répartit n indices sur tout le volume, premier et dernier inclus", () => {
    const idx = pickSampleIndices(237, 16);
    expect(idx.length).toBe(16);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(236);
    // strictement croissant
    for (let i = 1; i < idx.length; i++)
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it("renvoie toutes les coupes si n >= total", () => {
    expect(pickSampleIndices(5, 16)).toEqual([0, 1, 2, 3, 4]);
    expect(pickSampleIndices(3, 3)).toEqual([0, 1, 2]);
  });

  it("n=1 → la coupe du milieu", () => {
    expect(pickSampleIndices(10, 1)).toEqual([5]);
    expect(pickSampleIndices(237, 1)).toEqual([118]);
  });

  it("cas limites", () => {
    expect(pickSampleIndices(0, 16)).toEqual([]);
    expect(pickSampleIndices(10, 0)).toEqual([]);
  });

  it("dédoublonne sur petit volume (pas d'indices répétés)", () => {
    const idx = pickSampleIndices(4, 16);
    expect(new Set(idx).size).toBe(idx.length);
    expect(idx).toEqual([0, 1, 2, 3]);
  });
});
