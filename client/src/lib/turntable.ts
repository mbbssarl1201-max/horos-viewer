/**
 * Logique PURE de l'export « turntable » (vidéo de rotation du rendu 3D).
 * Sans DOM ni Cornerstone : juste la géométrie, donc testable.
 */

/**
 * `frames` angles répartis uniformément sur un tour complet (2π), à partir de 0.
 * `frames <= 0` → tableau vide.
 */
export function turntableAngles(frames: number): number[] {
  if (!Number.isFinite(frames) || frames <= 0) return [];
  const n = Math.floor(frames);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((2 * Math.PI * i) / n);
  return out;
}

/**
 * Fait orbiter `position` autour de l'axe `axis` (typiquement le viewUp de la
 * caméra) passant par `focalPoint`, d'un angle `angleRad` (rotation de Rodrigues).
 * Renvoie la nouvelle position. La distance au point focal est préservée.
 * Si l'axe est dégénéré (norme nulle), renvoie la position inchangée.
 */
export function orbitAroundFocalPoint(
  position: readonly number[],
  focalPoint: readonly number[],
  axis: readonly number[],
  angleRad: number
): [number, number, number] {
  const v = [
    position[0] - focalPoint[0],
    position[1] - focalPoint[1],
    position[2] - focalPoint[2],
  ];
  const an = Math.hypot(axis[0], axis[1], axis[2]);
  if (an === 0) return [position[0], position[1], position[2]];
  const k = [axis[0] / an, axis[1] / an, axis[2] / an];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const kxv = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  const kdv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const r = [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
  return [focalPoint[0] + r[0], focalPoint[1] + r[1], focalPoint[2] + r[2]];
}
