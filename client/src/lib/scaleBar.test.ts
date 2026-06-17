import { describe, it, expect } from "vitest";
import { computeScaleBar } from "./scaleBar";

describe("computeScaleBar", () => {
  it("spacing null → null", () => {
    expect(computeScaleBar(null, 1, 500)).toBeNull();
  });
  it("zoom ≤ 0 → null", () => {
    expect(computeScaleBar(0.5, 0, 500)).toBeNull();
  });
  it("choisit un pas rond qui tient dans la largeur", () => {
    // 1px = 0.5mm écran ; 200px → 100mm dispo (max 1/4 = 25mm) → pas rond ≤ 25
    const r = computeScaleBar(0.5, 1, 800);
    expect(r).not.toBeNull();
    expect([1, 2, 5, 10, 20, 50, 100, 200]).toContain(r!.labelMm);
    expect(r!.barPx).toBeLessThanOrEqual(800 / 4 + 1);
  });
  it("zoom plus grand → barre plus longue pour le même mm", () => {
    const a = computeScaleBar(0.5, 1, 1000)!;
    const b = computeScaleBar(0.5, 2, 1000)!;
    // à mm égal, la barre est ~2× plus longue ; sinon le label augmente
    expect(b.barPx / b.labelMm).toBeCloseTo((a.barPx / a.labelMm) * 2, 1);
  });
});
