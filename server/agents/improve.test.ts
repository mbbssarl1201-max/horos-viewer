import { describe, it, expect } from "vitest";
import { kpiNeedsImprovement } from "./improve";

describe("auto-amélioration", () => {
  it("max sous la cible → à améliorer", () => {
    expect(kpiNeedsImprovement({ value: 55, target: 70, goal: "max" })).toBe(
      true
    );
    expect(kpiNeedsImprovement({ value: 80, target: 70, goal: "max" })).toBe(
      false
    );
  });
  it("min au-dessus de la cible → à améliorer", () => {
    expect(
      kpiNeedsImprovement({ value: 12000, target: 8000, goal: "min" })
    ).toBe(true);
    expect(
      kpiNeedsImprovement({ value: 5000, target: 8000, goal: "min" })
    ).toBe(false);
  });
});
