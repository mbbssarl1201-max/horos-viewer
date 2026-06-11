import { describe, it, expect } from "vitest";
import {
  extractMeasurements,
  referencedSopFromAnnotation,
} from "./annotationMeasure";

describe("extractMeasurements", () => {
  it("extracts length in mm", () => {
    const data = { cachedStats: { "imageId:0": { length: 42.73 } } };
    const m = extractMeasurements("length", data);
    expect(m).toEqual([{ label: "Length", value: 42.73, unit: "mm" }]);
  });

  it("extracts angle in deg", () => {
    const data = { cachedStats: { "imageId:0": { angle: 31.4 } } };
    expect(extractMeasurements("angle", data)).toEqual([
      { label: "Angle", value: 31.4, unit: "deg" },
    ]);
  });

  it("extracts ROI area + mean + stdDev", () => {
    const data = {
      cachedStats: {
        "imageId:0": {
          area: 88.2,
          mean: 41.0,
          stdDev: 12.3,
          min: -10,
          max: 90,
        },
      },
    };
    const m = extractMeasurements("ellipse_roi", data);
    expect(m.map(x => x.label)).toEqual(["Area", "Mean", "Standard Deviation"]);
    expect(m[0]).toMatchObject({ value: 88.2, unit: "mm2" });
  });

  it("text annotation yields no measurement", () => {
    expect(extractMeasurements("text", { cachedStats: {} })).toEqual([]);
  });

  it("returns [] when stats not yet computed (fail-soft)", () => {
    expect(extractMeasurements("length", {})).toEqual([]);
    expect(extractMeasurements("length", null)).toEqual([]);
    expect(extractMeasurements("length", { cachedStats: {} })).toEqual([]);
  });

  it("ignores non-finite values", () => {
    const data = { cachedStats: { k: { length: NaN } } };
    expect(extractMeasurements("length", data)).toEqual([]);
  });
});

describe("referencedSopFromAnnotation", () => {
  it("pulls SOP UID from a wadors imageId", () => {
    const data = {
      metadata: {
        referencedImageId:
          "wadors:https://x/studies/1.2/series/1.3/instances/1.4.5/frames/1",
      },
    };
    expect(referencedSopFromAnnotation(data)).toBe("1.4.5");
  });

  it("returns null for a wadouri url without SOP", () => {
    const data = { metadata: { referencedImageId: "wadouri:https://x/a.dcm" } };
    expect(referencedSopFromAnnotation(data)).toBeNull();
  });

  it("returns null when absent", () => {
    expect(referencedSopFromAnnotation({})).toBeNull();
    expect(referencedSopFromAnnotation(null)).toBeNull();
  });
});
