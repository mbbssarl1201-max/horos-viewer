import { describe, it, expect } from "vitest";
import {
  clampOpacity,
  normalizeOpacityPoints,
  defaultOpacityRamp,
  serializePresets,
  deserializePresets,
} from "./transferFunction";

describe("clampOpacity", () => {
  it("borne dans [0,1] et gère NaN", () => {
    expect(clampOpacity(1.4)).toBe(1);
    expect(clampOpacity(-0.1)).toBe(0);
    expect(clampOpacity(0.5)).toBe(0.5);
    expect(clampOpacity(NaN)).toBe(0);
  });
});

describe("normalizeOpacityPoints", () => {
  it("trie par valeur, borne l'opacité, retire les valeurs non finies", () => {
    const out = normalizeOpacityPoints([
      { value: 300, opacity: 1.5 },
      { value: 0, opacity: -1 },
      { value: NaN, opacity: 0.5 },
    ]);
    expect(out).toEqual([
      { value: 0, opacity: 0 },
      { value: 300, opacity: 1 },
    ]);
  });
});

describe("defaultOpacityRamp", () => {
  it("rampe 0→1 entre lo et hi", () => {
    expect(defaultOpacityRamp(-200, 800)).toEqual([
      { value: -200, opacity: 0 },
      { value: 800, opacity: 1 },
    ]);
  });
});

describe("serialize/deserialize presets", () => {
  it("round-trip, et JSON invalide → []", () => {
    const presets = [
      { name: "Mon os", points: [{ value: 200, opacity: 0.2 }] },
    ];
    const json = serializePresets(presets);
    expect(deserializePresets(json)).toEqual(presets);
    expect(deserializePresets(null)).toEqual([]);
    expect(deserializePresets("{pas du json")).toEqual([]);
    expect(deserializePresets('{"x":1}')).toEqual([]);
  });
});
