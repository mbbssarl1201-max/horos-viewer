import { describe, it, expect } from "vitest";
import { normalizeName } from "./db";
describe("normalizeName", () => {
  it("normalise casse/accents/espaces/^", () => {
    expect(normalizeName("  POCINCI^Zehra ")).toBe("pocinci zehra");
    expect(normalizeName("Éva  SON")).toBe("eva son");
  });
  it("vide si vide", () => {
    expect(normalizeName(null)).toBe("");
  });
});
