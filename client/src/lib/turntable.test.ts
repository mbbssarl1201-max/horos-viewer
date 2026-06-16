import { describe, it, expect } from "vitest";
import { turntableAngles, orbitAroundFocalPoint } from "./turntable";

describe("turntableAngles", () => {
  it("répartit `frames` angles sur un tour complet, en commençant à 0", () => {
    const a = turntableAngles(4);
    expect(a).toHaveLength(4);
    expect(a[0]).toBeCloseTo(0, 6);
    expect(a[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(a[3]).toBeCloseTo((3 * Math.PI) / 2, 6);
  });
  it("frames <= 0 → tableau vide", () => {
    expect(turntableAngles(0)).toEqual([]);
    expect(turntableAngles(-5)).toEqual([]);
  });
});

describe("orbitAroundFocalPoint", () => {
  it("tourne la position autour de l'axe viewUp en gardant la distance", () => {
    const p = orbitAroundFocalPoint(
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
      Math.PI / 2
    );
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(1, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });
  it("angle 0 → position inchangée", () => {
    const p = orbitAroundFocalPoint([3, 1, 2], [0, 0, 0], [0, 0, 1], 0);
    expect(p[0]).toBeCloseTo(3, 6);
    expect(p[1]).toBeCloseTo(1, 6);
    expect(p[2]).toBeCloseTo(2, 6);
  });
  it("préserve la distance au point focal", () => {
    const fp = [5, 5, 5];
    const p = orbitAroundFocalPoint([5, 8, 5], fp, [0, 1, 0], 1.2345);
    const d = Math.hypot(p[0] - fp[0], p[1] - fp[1], p[2] - fp[2]);
    expect(d).toBeCloseTo(3, 6);
  });
});
