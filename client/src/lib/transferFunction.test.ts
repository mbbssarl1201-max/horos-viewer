import { describe, it, expect } from "vitest";
import {
  clampOpacity,
  normalizeOpacityPoints,
  defaultOpacityRamp,
  serializePresets,
  deserializePresets,
  hexToRgb01,
  rgb01ToHex,
  normalizeColorPoints,
  defaultColorPoints,
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

describe("hexToRgb01 / rgb01ToHex", () => {
  it("#ff0000 → {1,0,0}", () => {
    expect(hexToRgb01("#ff0000")).toEqual({ r: 1, g: 0, b: 0 });
  });
  it("#00ff00 → {0,1,0}", () => {
    expect(hexToRgb01("#00ff00")).toEqual({ r: 0, g: 1, b: 0 });
  });
  it("hex invalide → noir", () => {
    expect(hexToRgb01("nope")).toEqual({ r: 0, g: 0, b: 0 });
  });
  it("round-trip rgb01ToHex(hexToRgb01)", () => {
    expect(
      rgb01ToHex(
        ...(Object.values(hexToRgb01("#3366cc")) as [number, number, number])
      )
    ).toBe("#3366cc");
  });
});

describe("normalizeColorPoints", () => {
  it("trie par value et clampe rgb", () => {
    const out = normalizeColorPoints([
      { value: 100, r: 2, g: -1, b: 0.5 },
      { value: 0, r: 0, g: 0, b: 0 },
    ]);
    expect(out.map(p => p.value)).toEqual([0, 100]);
    expect(out[1]).toEqual({ value: 100, r: 1, g: 0, b: 0.5 });
  });
  it("retire les value non finies", () => {
    expect(normalizeColorPoints([{ value: NaN, r: 0, g: 0, b: 0 }])).toEqual(
      []
    );
  });
});

describe("defaultColorPoints", () => {
  it("noir (lo) → blanc (hi)", () => {
    const p = defaultColorPoints(-1000, 1000);
    expect(p).toEqual([
      { value: -1000, r: 0, g: 0, b: 0 },
      { value: 1000, r: 1, g: 1, b: 1 },
    ]);
  });
});
