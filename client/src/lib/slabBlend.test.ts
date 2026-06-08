import { describe, it, expect } from "vitest";
import { SLAB_MODES, slabModeToBlend } from "./slabBlend";

describe("slabModeToBlend", () => {
  it("mappe chaque mode vers une constante BlendModes", () => {
    expect(slabModeToBlend("mip")).toBe("MAXIMUM_INTENSITY_BLEND");
    expect(slabModeToBlend("minip")).toBe("MINIMUM_INTENSITY_BLEND");
    expect(slabModeToBlend("average")).toBe("AVERAGE_INTENSITY_BLEND");
  });
  it("expose les modes pour l'UI", () => {
    expect(SLAB_MODES.map(m => m.id)).toEqual(["mip", "minip", "average"]);
  });
});
