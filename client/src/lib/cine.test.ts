import { describe, it, expect } from "vitest";
import {
  CINE_FPS_OPTIONS,
  DEFAULT_CINE_FPS,
  nextCineIndex,
  fpsToIntervalMs,
} from "./cine";

describe("nextCineIndex", () => {
  it("avance d'une coupe", () => {
    expect(nextCineIndex(0, 5)).toBe(1);
    expect(nextCineIndex(3, 5)).toBe(4);
  });
  it("boucle au début par défaut", () => {
    expect(nextCineIndex(4, 5)).toBe(0);
  });
  it("reste sur la dernière coupe sans boucle", () => {
    expect(nextCineIndex(4, 5, false)).toBe(4);
  });
  it("gère les entrées dégénérées", () => {
    expect(nextCineIndex(0, 0)).toBe(0);
    expect(nextCineIndex(0, 1)).toBe(0);
    expect(nextCineIndex(2, 1)).toBe(0);
  });
});

describe("fpsToIntervalMs", () => {
  it("convertit la cadence en intervalle", () => {
    expect(fpsToIntervalMs(10)).toBe(100);
    expect(fpsToIntervalMs(DEFAULT_CINE_FPS)).toBeCloseTo(66.67, 1);
  });
  it("borne le fps à au moins 1", () => {
    expect(fpsToIntervalMs(0)).toBe(1000);
  });
});

describe("CINE_FPS_OPTIONS", () => {
  it("contient la cadence par défaut", () => {
    expect(CINE_FPS_OPTIONS).toContain(DEFAULT_CINE_FPS);
  });
});
