import { describe, it, expect } from "vitest";
import { extractGraphic } from "./annotationGraphics";

describe("extractGraphic", () => {
  it("builds a POLYLINE for a length annotation", () => {
    const data = {
      handles: {
        points: [
          [0, 0, 5],
          [10, 20, 5],
        ],
      },
    };
    const g = extractGraphic("length", data);
    expect(g?.graphicType).toBe("POLYLINE");
    expect(g?.numberOfPoints).toBe(2);
    expect(g?.points).toHaveLength(4);
    // display-relative coords clamped into the 0.1..0.9 band
    g?.points.forEach(c => {
      expect(c).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(c).toBeLessThanOrEqual(0.9 + 1e-9);
    });
  });

  it("builds an ELLIPSE (4 points) for an ellipse ROI", () => {
    const data = {
      handles: {
        points: [
          [0, 5, 0],
          [10, 5, 0],
          [5, 0, 0],
          [5, 10, 0],
        ],
      },
    };
    const g = extractGraphic("ellipse_roi", data);
    expect(g?.graphicType).toBe("ELLIPSE");
    expect(g?.numberOfPoints).toBe(4);
    expect(g?.points).toHaveLength(8);
  });

  it("builds a POINT for a text annotation", () => {
    const data = { handles: { points: [[3, 4, 0]] } };
    const g = extractGraphic("text", data);
    expect(g?.graphicType).toBe("POINT");
    expect(g?.numberOfPoints).toBe(1);
  });

  it("returns null when no usable points (fail-soft)", () => {
    expect(extractGraphic("length", {})).toBeNull();
    expect(extractGraphic("length", { handles: { points: [] } })).toBeNull();
    expect(extractGraphic("length", null)).toBeNull();
  });

  it("ignores malformed points", () => {
    const data = { handles: { points: [[NaN, 1, 0], [1]] } };
    expect(extractGraphic("length", data)).toBeNull();
  });
});
