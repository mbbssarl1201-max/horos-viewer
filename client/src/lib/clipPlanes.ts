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

export interface ObliqueClipConfig {
  enabled: boolean;
  /** Azimut autour de Z, en degrés [0..360). */
  azimuthDeg: number;
  /** Élévation, en degrés [-90..90]. */
  elevationDeg: number;
  /** Position le long de la normale, normalisée [0..1]. */
  position: number;
  invert: boolean;
}

/**
 * Plan de coupe OBLIQUE : normale dérivée des angles sphériques (azimut/élévation),
 * origine = centre du volume décalé le long de la normale par `position01`. PUR.
 */
export function obliqueClipPlane(
  bounds: readonly number[],
  azimuthDeg: number,
  elevationDeg: number,
  position01: number,
  invert: boolean
): ClipPlaneSpec {
  const az = ((azimuthDeg % 360) * Math.PI) / 180;
  const el = (Math.min(90, Math.max(-90, elevationDeg)) * Math.PI) / 180;
  const s = invert ? -1 : 1;
  const normal: [number, number, number] = [
    s * Math.cos(el) * Math.cos(az),
    s * Math.cos(el) * Math.sin(az),
    s * Math.sin(el),
  ];
  const cx = (bounds[0] + bounds[1]) / 2;
  const cy = (bounds[2] + bounds[3]) / 2;
  const cz = (bounds[4] + bounds[5]) / 2;
  const dx = bounds[1] - bounds[0];
  const dy = bounds[3] - bounds[2];
  const dz = bounds[5] - bounds[4];
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const t = (clampClipPosition(position01) - 0.5) * diag;
  const origin: [number, number, number] = [
    cx + normal[0] * t,
    cy + normal[1] * t,
    cz + normal[2] * t,
  ];
  return { origin, normal };
}

/** Spec du plan oblique si activé et bounds valides, sinon null. PUR. */
export function buildObliqueClipPlane(
  bounds: readonly number[] | null | undefined,
  config: ObliqueClipConfig
): ClipPlaneSpec | null {
  if (!config.enabled || !bounds || bounds.length < 6) return null;
  return obliqueClipPlane(
    bounds,
    config.azimuthDeg,
    config.elevationDeg,
    config.position,
    config.invert
  );
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
