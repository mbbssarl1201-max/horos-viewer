import { describe, it, expect } from "vitest";
import { annotationDataSchema } from "./annotationSchema";

// Annotation Cornerstone réaliste (outil Length)
const lengthAnnotation = {
  annotationUID: "abc-123",
  highlighted: false,
  isLocked: false,
  isVisible: true,
  metadata: {
    toolName: "Length",
    referencedImageId: "wadouri:https://x/manus-storage/dicom/1/2/3/4.dcm",
    FrameOfReferenceUID: "1.2.3",
    viewPlaneNormal: [0, 0, -1],
  },
  data: {
    handles: {
      points: [
        [10, 20, 0],
        [30, 40, 0],
      ],
    },
    cachedStats: { "imageId:foo": { length: 48.3, unit: "mm" } },
    label: "",
  },
};

describe("annotationDataSchema", () => {
  it("accepte une annotation Length réaliste", () => {
    expect(annotationDataSchema.safeParse(lengthAnnotation).success).toBe(true);
  });

  it("accepte un ROI à main levée avec de nombreux points", () => {
    const freehand = {
      metadata: { toolName: "PlanarFreehandROI" },
      data: {
        handles: { points: Array.from({ length: 800 }, (_, i) => [i, i, 0]) },
      },
    };
    expect(annotationDataSchema.safeParse(freehand).success).toBe(true);
  });

  it("rejette un payload sans metadata.toolName", () => {
    expect(
      annotationDataSchema.safeParse({ data: {}, metadata: {} }).success
    ).toBe(false);
    expect(annotationDataSchema.safeParse({ data: {} }).success).toBe(false);
  });

  it("rejette un payload sans data", () => {
    expect(
      annotationDataSchema.safeParse({ metadata: { toolName: "Length" } })
        .success
    ).toBe(false);
  });

  it("rejette un payload trop volumineux (> 256 Ko)", () => {
    const huge = {
      metadata: { toolName: "Length" },
      data: { blob: "x".repeat(300_000) },
    };
    expect(annotationDataSchema.safeParse(huge).success).toBe(false);
  });

  it("rejette une valeur non-objet", () => {
    expect(annotationDataSchema.safeParse("nope").success).toBe(false);
    expect(annotationDataSchema.safeParse(null).success).toBe(false);
  });
});
