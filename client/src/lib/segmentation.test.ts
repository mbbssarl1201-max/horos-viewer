import { describe, it, expect } from "vitest";
import {
  isSegmentationTool,
  resolveBrushStrategy,
  clampBrushSize,
  segmentationIdForViewport,
  BRUSH_FILL_STRATEGY,
  BRUSH_ERASE_STRATEGY,
  DEFAULT_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  MAX_BRUSH_SIZE,
} from "./segmentation";

describe("isSegmentationTool", () => {
  it("reconnaît pinceau et gomme", () => {
    expect(isSegmentationTool("brush")).toBe(true);
    expect(isSegmentationTool("eraser")).toBe(true);
  });
  it("rejette les autres outils", () => {
    for (const id of ["wwwl", "zoom", "length", "rect", "probe", ""]) {
      expect(isSegmentationTool(id)).toBe(false);
    }
  });
});

describe("resolveBrushStrategy", () => {
  it("pinceau → FILL, gomme → ERASE", () => {
    expect(resolveBrushStrategy("brush")).toBe(BRUSH_FILL_STRATEGY);
    expect(resolveBrushStrategy("eraser")).toBe(BRUSH_ERASE_STRATEGY);
  });
  it("renvoie null pour un outil non-segmentation", () => {
    expect(resolveBrushStrategy("wwwl")).toBeNull();
    expect(resolveBrushStrategy("length")).toBeNull();
  });
});

describe("clampBrushSize", () => {
  it("borne dans [min, max]", () => {
    expect(clampBrushSize(0)).toBe(MIN_BRUSH_SIZE);
    expect(clampBrushSize(-5)).toBe(MIN_BRUSH_SIZE);
    expect(clampBrushSize(1000)).toBe(MAX_BRUSH_SIZE);
    expect(clampBrushSize(30)).toBe(30);
  });
  it("arrondit les valeurs fractionnaires", () => {
    expect(clampBrushSize(12.4)).toBe(12);
    expect(clampBrushSize(12.6)).toBe(13);
  });
  it("retombe sur le défaut pour NaN/Infinity", () => {
    expect(clampBrushSize(NaN)).toBe(DEFAULT_BRUSH_SIZE);
    expect(clampBrushSize(Infinity)).toBe(DEFAULT_BRUSH_SIZE);
  });
});

describe("segmentationIdForViewport", () => {
  it("préfixe l'id du viewport et reste distinct par viewport", () => {
    expect(segmentationIdForViewport("CT_VIEWPORT")).toBe("SEG_CT_VIEWPORT");
    expect(segmentationIdForViewport("CT_VIEWPORT_cell0")).not.toBe(
      segmentationIdForViewport("CT_VIEWPORT_cell1")
    );
  });
});
