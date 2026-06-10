import { describe, it, expect } from "vitest";
import {
  toolNameToDbType,
  stripImageIdScheme,
  resolveInstanceId,
  extractRoiStats,
  type InstanceLike,
} from "./annotationMapping";

describe("toolNameToDbType", () => {
  it("maps known cornerstone tool names to DB enums", () => {
    expect(toolNameToDbType("Length")).toBe("length");
    expect(toolNameToDbType("Angle")).toBe("angle");
    expect(toolNameToDbType("RectangleROI")).toBe("rect_roi");
    expect(toolNameToDbType("EllipticalROI")).toBe("ellipse_roi");
    expect(toolNameToDbType("ArrowAnnotate")).toBe("text");
  });

  it("returns null for unknown / non-persisted tools", () => {
    expect(toolNameToDbType("WindowLevel")).toBeNull();
    expect(toolNameToDbType(undefined)).toBeNull();
    expect(toolNameToDbType(null)).toBeNull();
    expect(toolNameToDbType("")).toBeNull();
  });
});

describe("stripImageIdScheme", () => {
  it("strips wadouri: and wadors: prefixes", () => {
    expect(stripImageIdScheme("wadouri:https://x/y.dcm")).toBe(
      "https://x/y.dcm"
    );
    expect(stripImageIdScheme("wadors:https://x/y.dcm")).toBe(
      "https://x/y.dcm"
    );
  });

  it("leaves a bare url untouched", () => {
    expect(stripImageIdScheme("https://x/y.dcm")).toBe("https://x/y.dcm");
  });
});

describe("resolveInstanceId", () => {
  const instances: InstanceLike[] = [
    { id: 10, storageUrl: "https://s3/a.dcm" },
    { id: 11, storageUrl: "https://s3/b.dcm" },
    { id: 12, storageUrl: "https://s3/c.dcm" },
  ];

  it("matches by referencedImageId (wadouri prefixed) to instance id", () => {
    expect(resolveInstanceId("wadouri:https://s3/b.dcm", instances, 0)).toBe(
      11
    );
  });

  it("falls back to the current slice when no referencedImageId", () => {
    expect(resolveInstanceId(undefined, instances, 2)).toBe(12);
    expect(resolveInstanceId(null, instances, 0)).toBe(10);
  });

  it("falls back to the current slice when referencedImageId matches nothing", () => {
    expect(
      resolveInstanceId("wadouri:https://s3/unknown.dcm", instances, 1)
    ).toBe(11);
  });

  it("returns null when no match and slice out of range", () => {
    expect(resolveInstanceId(undefined, instances, 99)).toBeNull();
    expect(resolveInstanceId(null, [], 0)).toBeNull();
  });
});

describe("extractRoiStats", () => {
  it("extracts the first cachedStats entry", () => {
    const annotation = {
      data: {
        cachedStats: {
          "imageId:foo": {
            mean: 42.5,
            stdDev: 3.1,
            min: 10,
            max: 80,
            area: 12.3,
          },
        },
      },
    };
    expect(extractRoiStats(annotation)).toEqual({
      mean: 42.5,
      stdDev: 3.1,
      min: 10,
      max: 80,
      area: 12.3,
    });
  });

  it("defaults missing numeric fields to 0", () => {
    const annotation = {
      data: { cachedStats: { k: { mean: 5 } } },
    };
    expect(extractRoiStats(annotation)).toEqual({
      mean: 5,
      stdDev: 0,
      min: 0,
      max: 0,
      area: 0,
    });
  });

  it("returns null when stats are absent or not yet computed", () => {
    expect(extractRoiStats({ data: {} })).toBeNull();
    expect(extractRoiStats({ data: { cachedStats: {} } })).toBeNull();
    expect(extractRoiStats({ data: { cachedStats: { k: {} } } })).toBeNull();
    expect(extractRoiStats(null)).toBeNull();
    expect(extractRoiStats(undefined)).toBeNull();
  });
});
