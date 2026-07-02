import { describe, it, expect } from "vitest";
import {
  formatCursorReadout,
  patientOrientationLabels,
  formatImageInfo,
} from "./viewportOverlay";

describe("formatCursorReadout", () => {
  it("px + mm + valeur", () => {
    const s = formatCursorReadout({
      xPx: 2224,
      yPx: 1759,
      xMm: 305.79,
      yMm: 241.9,
      value: 0,
    });
    expect(s).toContain("px (2224, 1759)");
    expect(s).toContain("305.8 mm");
    expect(s).toContain("241.9 mm");
    expect(s).toContain("Val 0");
  });
  it("mm omis si null", () => {
    const s = formatCursorReadout({
      xPx: 10,
      yPx: 20,
      xMm: null,
      yMm: null,
      value: 5,
    });
    expect(s).toContain("px (10, 20)");
    expect(s).not.toContain("mm");
  });
});

describe("patientOrientationLabels", () => {
  it("axial (iop standard) → L/R/A/P", () => {
    const l = patientOrientationLabels([1, 0, 0, 0, 1, 0]);
    expect(l.left).toBe("R");
    expect(l.right).toBe("L");
    expect(l.top).toBe("A");
    expect(l.bottom).toBe("P");
  });
  it("iop null → vides", () => {
    expect(patientOrientationLabels(null)).toEqual({
      top: "",
      bottom: "",
      left: "",
      right: "",
    });
  });
});

describe("formatImageInfo", () => {
  it("compose les lignes présentes", () => {
    const lines = formatImageInfo({
      rows: 512,
      cols: 512,
      zoomPct: 86,
      angleDeg: 0,
    });
    expect(lines.join(" ")).toContain("512");
    expect(lines.join(" ")).toContain("86");
  });
});
