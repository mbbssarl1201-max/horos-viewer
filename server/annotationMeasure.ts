/**
 * PURE extraction of a measurement VALUE + UNIT from a stored Cornerstone3D
 * annotation (the JSON kept in the `annotations.data` column), keyed by our DB
 * `type` enum. Used by the DICOM SR builder to encode numeric measurements.
 *
 * Cornerstone stashes computed results in `data.cachedStats`, an object keyed
 * by an opaque viewport/image key, e.g.
 *   length:  { "imageId:0": { length: 42.7, unit: "mm" } }
 *   angle:   { "imageId:0": { angle: 31.4 } }
 *   ROI:     { "imageId:0": { area: 88.2, mean: 41.0, stdDev: 12.3, ... } }
 *
 * We read the FIRST cachedStats entry (a single annotation only has one). All
 * helpers are side-effect free and defensive: a half-drawn annotation whose
 * stats aren't computed yet yields `null` (the SR simply omits it) — never a
 * throw, so SR export can't break on incomplete data.
 */

import type { AnnotationDbType } from "../client/src/lib/annotationMapping";

export interface Measurement {
  // DICOM-coded concept name for the SR measurement (human label here; the SR
  // builder maps it to a coded concept).
  label: string;
  value: number;
  unit: string; // UCUM-ish unit string ("mm", "deg", "mm2", "{H}U")
}

type CachedStats = Record<string, Record<string, unknown> | undefined>;

/** Return the first cachedStats record of an annotation, or null. */
function firstStats(data: unknown): Record<string, unknown> | null {
  const cached = (data as { cachedStats?: CachedStats } | null)?.cachedStats;
  if (!cached || typeof cached !== "object") return null;
  const first = Object.values(cached)[0];
  return first && typeof first === "object" ? first : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Extract the measurement(s) carried by a stored annotation given its DB type.
 * Returns an array because an ROI carries several (area + mean + stdDev). Empty
 * array when nothing is computable (caller omits it from the SR).
 */
export function extractMeasurements(
  type: AnnotationDbType,
  data: unknown
): Measurement[] {
  const stats = firstStats(data);
  if (!stats) return [];
  const out: Measurement[] = [];

  switch (type) {
    case "length": {
      const v = num(stats.length);
      if (v !== null) out.push({ label: "Length", value: v, unit: "mm" });
      break;
    }
    case "angle": {
      const v = num(stats.angle);
      if (v !== null) out.push({ label: "Angle", value: v, unit: "deg" });
      break;
    }
    case "rect_roi":
    case "ellipse_roi": {
      const area = num(stats.area);
      if (area !== null) out.push({ label: "Area", value: area, unit: "mm2" });
      const mean = num(stats.mean);
      if (mean !== null)
        out.push({ label: "Mean", value: mean, unit: "[hnsf'U]" });
      const stdDev = num(stats.stdDev);
      if (stdDev !== null)
        out.push({
          label: "Standard Deviation",
          value: stdDev,
          unit: "[hnsf'U]",
        });
      break;
    }
    case "text":
      // Text/arrow annotations carry no numeric measurement.
      break;
  }
  return out;
}

/** SOPInstanceUID referenced by an annotation, read from its metadata. */
export function referencedSopFromAnnotation(data: unknown): string | null {
  const meta = (data as { metadata?: { referencedImageId?: unknown } } | null)
    ?.metadata;
  const refId = meta?.referencedImageId;
  if (typeof refId !== "string" || !refId) return null;
  // imageId looks like "wadouri:<url>" or "wadors:.../instances/<sop>/frames/1".
  // Try to pull a trailing SOP UID (dotted numeric) if present; otherwise null
  // and the SR falls back to the instance's known SOP UID supplied by caller.
  const m = refId.match(/instances\/([0-9.]+)/);
  return m ? m[1] : null;
}
