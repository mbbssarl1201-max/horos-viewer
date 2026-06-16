/**
 * Logique PURE des plans de coupe (clipping) du rendu 3D : à partir des bounds
 * du volume [xmin,xmax,ymin,ymax,zmin,zmax] et d'une position normalisée [0..1]
 * sur un axe, calcule l'origine + la normale d'un plan vtk. Sans DOM/VTK, testable.
 */

export type ClipAxis = "x" | "y" | "z";

export interface ClipPlaneConfig {
  axis: ClipAxis;
  enabled: boolean;
  /** Position le long de l'axe, normalisée [0..1]. */
  position: number;
  /** Inverse le demi-espace conservé. */
  invert: boolean;
}

export interface ClipPlaneSpec {
  origin: [number, number, number];
  normal: [number, number, number];
}

/** Borne une position de coupe dans [0,1] ; entrée invalide → 0.5 (milieu). */
export function clampClipPosition(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1, Math.max(0, p));
}

/**
 * Origine + normale d'un plan de coupe sur `axis`, à la position normalisée
 * `position01` de l'étendue du volume. La normale pointe vers le demi-espace
 * CONSERVÉ ; `invert` la retourne.
 */
export function axisClipPlane(
  bounds: readonly number[],
  axis: ClipAxis,
  position01: number,
  invert: boolean
): ClipPlaneSpec {
  const pos = clampClipPosition(position01);
  const idx = axis === "x" ? 0 : axis === "y" ? 2 : 4;
  const lo = bounds[idx];
  const hi = bounds[idx + 1];
  const w = lo + (hi - lo) * pos;
  const cx = (bounds[0] + bounds[1]) / 2;
  const cy = (bounds[2] + bounds[3]) / 2;
  const cz = (bounds[4] + bounds[5]) / 2;
  const origin: [number, number, number] =
    axis === "x" ? [w, cy, cz] : axis === "y" ? [cx, w, cz] : [cx, cy, w];
  const s = invert ? -1 : 1;
  const normal: [number, number, number] =
    axis === "x" ? [s, 0, 0] : axis === "y" ? [0, s, 0] : [0, 0, s];
  return { origin, normal };
}

/**
 * Construit les specs des plans ACTIVÉS. `bounds` invalide (< 6 valeurs) → [].
 */
export function buildClipPlanes(
  bounds: readonly number[] | null | undefined,
  configs: readonly ClipPlaneConfig[]
): ClipPlaneSpec[] {
  if (!bounds || bounds.length < 6) return [];
  return configs
    .filter(c => c.enabled)
    .map(c => axisClipPlane(bounds, c.axis, c.position, c.invert));
}
