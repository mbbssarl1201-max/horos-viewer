import { describe, it, expect } from "vitest";
import { isReconstructable, clampSlabThickness } from "./volumeReconstruct";

describe("isReconstructable", () => {
  it(">= 2 imageIds → true", () => {
    expect(isReconstructable(["a", "b"])).toBe(true);
  });
  it("< 2 → false", () => {
    expect(isReconstructable(["a"])).toBe(false);
    expect(isReconstructable([])).toBe(false);
    expect(isReconstructable(undefined)).toBe(false);
  });
});

describe("clampSlabThickness", () => {
  it("borne entre 0 et max", () => {
    expect(clampSlabThickness(-5, 100)).toBe(0);
    expect(clampSlabThickness(150, 100)).toBe(100);
    expect(clampSlabThickness(20, 100)).toBe(20);
  });
});
