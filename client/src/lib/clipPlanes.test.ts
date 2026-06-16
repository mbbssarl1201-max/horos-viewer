import { describe, it, expect } from "vitest";
import {
  clampClipPosition,
  axisClipPlane,
  buildClipPlanes,
} from "./clipPlanes";

const B = [0, 10, 0, 20, 0, 30]; // xmin,xmax,ymin,ymax,zmin,zmax

describe("clampClipPosition", () => {
  it("borne dans [0,1] et gère NaN", () => {
    expect(clampClipPosition(1.5)).toBe(1);
    expect(clampClipPosition(-0.2)).toBe(0);
    expect(clampClipPosition(0.3)).toBeCloseTo(0.3, 6);
    expect(clampClipPosition(NaN)).toBe(0.5);
  });
});

describe("axisClipPlane", () => {
  it("X au milieu → origine x=5, normale +X ; inversion → -X", () => {
    const p = axisClipPlane(B, "x", 0.5, false);
    expect(p.origin).toEqual([5, 10, 15]);
    expect(p.normal).toEqual([1, 0, 0]);
    expect(axisClipPlane(B, "x", 0.5, true).normal).toEqual([-1, 0, 0]);
  });
  it("Z aux extrêmes → z=0 puis z=30", () => {
    expect(axisClipPlane(B, "z", 0, false).origin[2]).toBeCloseTo(0, 6);
    expect(axisClipPlane(B, "z", 1, false).origin[2]).toBeCloseTo(30, 6);
    expect(axisClipPlane(B, "z", 1, false).normal).toEqual([0, 0, 1]);
  });
  it("Y → normale sur l'axe Y", () => {
    expect(axisClipPlane(B, "y", 0.5, false).normal).toEqual([0, 1, 0]);
    expect(axisClipPlane(B, "y", 0.25, false).origin[1]).toBeCloseTo(5, 6);
  });
});

describe("buildClipPlanes", () => {
  it("ne garde que les plans activés ; bounds invalides → []", () => {
    const cfgs = [
      { axis: "x" as const, enabled: true, position: 0.5, invert: false },
      { axis: "y" as const, enabled: false, position: 0.5, invert: false },
      { axis: "z" as const, enabled: true, position: 0.2, invert: true },
    ];
    expect(buildClipPlanes(B, cfgs)).toHaveLength(2);
    expect(buildClipPlanes([1, 2, 3], cfgs)).toEqual([]);
    expect(buildClipPlanes(B, [])).toEqual([]);
  });
});
