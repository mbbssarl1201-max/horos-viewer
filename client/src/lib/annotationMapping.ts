/**
 * Pure helpers to bridge Cornerstone3D annotations and the DB `annotations`
 * table. Kept side-effect free so they can be unit-tested under
 * `client/src/lib/**` (the only client path the vitest config runs).
 */

// DB enum accepted by `trpc.annotations.save` ({ type }).
export type AnnotationDbType =
  | "length"
  | "angle"
  | "rect_roi"
  | "ellipse_roi"
  | "text";

// Minimal shape of the instances the viewer receives from
// `trpc.instances.listBySeries` — only the fields we need to map.
export interface InstanceLike {
  id: number;
  storageUrl?: string | null;
}

/**
 * Map a Cornerstone tool name (annotation.metadata.toolName) to our DB enum.
 * Cornerstone tool names are stable strings ("Length", "Angle",
 * "EllipticalROI", "RectangleROI", "ArrowAnnotate"). Returns null for any tool
 * we don't persist (e.g. WindowLevel/Pan/Zoom never produce annotations, but
 * be defensive against unknown tools so we never save a bad enum).
 *
 * Extended measurement tools have no dedicated DB enum value (the server enum
 * is fixed to length/angle/rect_roi/ellipse_roi/text and we must NOT migrate
 * it). We map each to the closest clinically-reasonable existing enum so they
 * still persist & re-hydrate (the full Cornerstone annotation — including its
 * real toolName — is stored in `data`, so the drawing is preserved exactly;
 * only the coarse `type` tag is approximated):
 *   - "CobbAngle"        → "angle"  (an inter-line angle, rachis)
 *   - "Bidirectional"    → "length" (perpendicular long/short axis linear extents, RECIST)
 *   - "Probe"            → "text"   (a labeled point carrying a punctual HU value)
 *   - "PlanarFreehandROI"→ "ellipse_roi" (a closed region-of-interest with ROI stats)
 */
export function toolNameToDbType(
  toolName: string | undefined | null
): AnnotationDbType | null {
  switch (toolName) {
    case "Length":
      return "length";
    case "Angle":
      return "angle";
    case "RectangleROI":
      return "rect_roi";
    case "EllipticalROI":
      return "ellipse_roi";
    case "ArrowAnnotate":
      return "text";
    case "CobbAngle":
      return "angle";
    case "Bidirectional":
      return "length";
    case "Probe":
      return "text";
    case "PlanarFreehandROI":
      return "ellipse_roi";
    default:
      return null;
  }
}

/**
 * Strip the cornerstone image-loader scheme prefix ("wadouri:" / "wadors:")
 * from a referencedImageId so it can be compared to an instance storageUrl.
 * Frame suffixes ("&frame=N") are left intact — storageUrl never carries one,
 * and stripping conservatively avoids accidental mismatches.
 */
export function stripImageIdScheme(imageId: string): string {
  return imageId.replace(/^wadouri:/, "").replace(/^wadors:/, "");
}

/**
 * Resolve the DB instance id for a given annotation.
 *
 * The viewer builds image ids as `wadouri:${instance.storageUrl}`, so the
 * annotation's `referencedImageId` strips back to a storageUrl we can match.
 * When the annotation has no referencedImageId (rare) we fall back to the
 * instance at `currentSlice` — that is the slice the user is looking at.
 *
 * Returns null when nothing matches (caller must skip the save rather than
 * persist against a wrong/foreign instance — important for a medical app).
 */
export function resolveInstanceId(
  referencedImageId: string | undefined | null,
  instances: InstanceLike[],
  currentSlice: number
): number | null {
  if (referencedImageId) {
    const target = stripImageIdScheme(referencedImageId);
    const match = instances.find(
      inst => inst.storageUrl && stripImageIdScheme(inst.storageUrl) === target
    );
    if (match) return match.id;
  }
  const fallback = instances[currentSlice];
  return fallback ? fallback.id : null;
}

/**
 * ROI HU statistics shown in the bottom-left overlay. Extracted from the first
 * cachedStats entry of an annotation (ellipse/rect ROI tools). Returns null
 * when the annotation carries no usable stats.
 */
export interface RoiStats {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  area: number;
}

export function extractRoiStats(annotation: unknown): RoiStats | null {
  const data = (annotation as { data?: { cachedStats?: unknown } } | null)
    ?.data;
  const cachedStats = data?.cachedStats as Record<string, unknown> | undefined;
  if (!cachedStats) return null;
  const stats = Object.values(cachedStats)[0] as Partial<RoiStats> | undefined;
  if (!stats) return null;
  // ROI tools always set `mean`; if it's missing the stats aren't ready yet.
  if (typeof stats.mean !== "number") return null;
  return {
    mean: stats.mean ?? 0,
    stdDev: stats.stdDev ?? 0,
    min: stats.min ?? 0,
    max: stats.max ?? 0,
    area: stats.area ?? 0,
  };
}
