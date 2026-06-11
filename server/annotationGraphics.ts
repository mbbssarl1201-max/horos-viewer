/**
 * PURE extraction of 2D graphic point lists from a stored Cornerstone3D
 * annotation, for encoding into a GSPS GraphicObjectSequence.
 *
 * IMPORTANT geometric limitation (documented, intentional): Cornerstone3D
 * stores annotation handle points as WORLD coordinates (mm, 3D). GSPS graphics
 * are 2D and expressed either in PIXEL or DISPLAY units relative to a specific
 * referenced image. Mapping world→pixel requires the exact image-plane module
 * (origin/orientation/spacing) which is not reliably available server-side.
 *
 * To stay FAIL-SAFE and still produce a *valid* GSPS, we encode the first two
 * components (X,Y) of each handle point as DISPLAY-relative 2D coordinates.
 * Real-world calibration may therefore be approximate; the GSPS remains a valid
 * Part-10 object that PACS/viewers accept, carrying the annotation geometry and
 * VOI. (For exact pixel placement, a future iteration should pass the image
 * plane down from the client and convert there.)
 */

import type { AnnotationDbType } from "../client/src/lib/annotationMapping";

export type GspsGraphicType = "POLYLINE" | "ELLIPSE" | "POINT";

export interface GspsGraphic {
  graphicType: GspsGraphicType;
  // Flat [x1,y1,x2,y2,...] DISPLAY-relative (0..1) 2D coordinates.
  points: number[];
  numberOfPoints: number;
}

/** Read `data.handles.points` (array of [x,y,z] world coords) defensively. */
function handlePoints(data: unknown): number[][] {
  const pts = (data as { handles?: { points?: unknown } } | null)?.handles
    ?.points;
  if (!Array.isArray(pts)) return [];
  return pts
    .filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
    .map(p => [Number(p[0]), Number(p[1])])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/**
 * Normalize a set of world XY points into DISPLAY-relative [0..1] coordinates
 * by their own bounding box (keeps shape; absolute scale is lost — see the
 * module-level limitation note). Returns a flat array.
 */
function toDisplayRelative(points: number[][]): number[] {
  if (points.length === 0) return [];
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  // Map into the central 0.1..0.9 band so the drawing is comfortably on-image.
  const flat: number[] = [];
  for (const [x, y] of points) {
    flat.push(0.1 + 0.8 * ((x - minX) / spanX));
    flat.push(0.1 + 0.8 * ((y - minY) / spanY));
  }
  return flat;
}

/**
 * Build the GSPS graphic for an annotation given its DB type. Returns null when
 * the annotation has no usable points (so the GSPS simply omits it — fail-soft).
 */
export function extractGraphic(
  type: AnnotationDbType,
  data: unknown
): GspsGraphic | null {
  const pts = handlePoints(data);
  if (pts.length === 0) return null;

  // ROI ellipse: Cornerstone stores 4 handle points (the ellipse bbox extents);
  // GSPS ELLIPSE wants exactly 4 points (major/minor axis endpoints). Map them.
  if (type === "ellipse_roi" && pts.length >= 4) {
    const flat = toDisplayRelative(pts.slice(0, 4));
    return { graphicType: "ELLIPSE", points: flat, numberOfPoints: 4 };
  }

  // Text/arrow: a single anchor point.
  if (type === "text" && pts.length >= 1) {
    const flat = toDisplayRelative(pts.slice(0, 1));
    return { graphicType: "POINT", points: flat, numberOfPoints: 1 };
  }

  // length / angle / rect_roi / freehand: open or closed polyline.
  const flat = toDisplayRelative(pts);
  return {
    graphicType: "POLYLINE",
    points: flat,
    numberOfPoints: pts.length,
  };
}
