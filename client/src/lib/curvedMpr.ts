/**
 * Curved MPR (CPR — Curved Planar Reformation) — version BASIQUE.
 *
 * Principe : l'utilisateur place une polyligne (centerline) de points monde
 * (mm) sur une coupe ; on rééchantillonne le volume scalaire LE LONG de cette
 * courbe pour produire une image 2D « déroulée / étirée » (stretched CPR).
 *
 *   • Axe horizontal (u) de l'image = abscisse curviligne (distance parcourue le
 *     long de la courbe), rééchantillonnée à pas régulier.
 *   • Axe vertical (v) de l'image = direction perpendiculaire à la courbe, dans
 *     le plan de coupe, sur une largeur paramétrable (mm).
 *
 * Fonctions PURES : aucune dépendance VTK/DOM. On échantillonne via les helpers
 * trilinéaires existants (`sampleVolumeTrilinear`, `worldToIndex` d'objExport) →
 * pas de duplication de la logique d'interpolation.
 *
 * LIMITATIONS (assumées, version « bêta ») :
 *   • Stretched CPR 2D plan, PAS un déroulé volumique 3D complet.
 *   • La direction perpendiculaire (v) est calculée dans le PLAN défini par la
 *     normale fournie (par défaut l'axe Z monde = plan axial). Pour un volume
 *     oblique, l'appelant doit fournir la bonne normale de plan.
 *   • `worldToIndex` suppose un volume axis-aligned (comme objExport / l'export
 *     OBJ). Cohérent avec le reste du visualiseur.
 */

import { sampleVolumeTrilinear, worldToIndex } from "./objExport";

export type Vec3 = readonly [number, number, number];

/** Longueur euclidienne d'un vecteur. */
function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Normalise un vecteur (renvoie [0,0,0] si nul). */
export function normalize(v: Vec3): [number, number, number] {
  const l = length(v);
  if (l === 0) return [0, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Soustraction a − b. */
function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Produit vectoriel a × b. */
export function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Longueur totale d'une polyligne (somme des segments). 0 ou 1 point → 0.
 */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += length(sub(points[i], points[i - 1]));
  }
  return total;
}

/**
 * Rééchantillonne une polyligne à pas curviligne RÉGULIER `step` (mm), en
 * renvoyant pour chaque échantillon sa position monde et sa tangente normalisée.
 *
 * Robuste : < 2 points ou step ≤ 0 → tableau vide. Les segments dégénérés (deux
 * points identiques) sont sautés pour le calcul de tangente.
 */
export interface CenterlineSample {
  position: [number, number, number];
  tangent: [number, number, number];
  /** Abscisse curviligne (mm) depuis le départ. */
  arcLength: number;
}

export function resampleCenterline(
  points: readonly Vec3[],
  step: number
): CenterlineSample[] {
  if (points.length < 2 || !(step > 0)) return [];

  // Pré-calcule les longueurs cumulées et tangentes de segment.
  const segLen: number[] = [];
  const segTan: [number, number, number][] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = sub(points[i], points[i - 1]);
    const l = length(d);
    segLen.push(l);
    segTan.push(normalize(d));
    total += l;
  }
  if (total === 0) return [];

  const samples: CenterlineSample[] = [];
  // Échantillons à 0, step, 2·step, … jusqu'à la longueur totale (incluse).
  for (let s = 0; s <= total + 1e-9; s += step) {
    const arc = Math.min(s, total);
    // Trouve le segment contenant l'abscisse `arc`.
    let acc = 0;
    let seg = 0;
    while (seg < segLen.length && acc + segLen[seg] < arc) {
      acc += segLen[seg];
      seg++;
    }
    if (seg >= segLen.length) seg = segLen.length - 1;
    const localLen = segLen[seg] || 1;
    const t = Math.min(1, Math.max(0, (arc - acc) / localLen));
    const p0 = points[seg];
    const p1 = points[seg + 1];
    const position: [number, number, number] = [
      p0[0] + (p1[0] - p0[0]) * t,
      p0[1] + (p1[1] - p0[1]) * t,
      p0[2] + (p1[2] - p0[2]) * t,
    ];
    samples.push({ position, tangent: segTan[seg], arcLength: arc });
  }
  return samples;
}

export interface CprOptions {
  /** Pas d'échantillonnage le long de la courbe (mm). Défaut 1. */
  stepMm?: number;
  /** Demi-largeur perpendiculaire (mm) de part et d'autre. Défaut 20. */
  halfWidthMm?: number;
  /** Pas d'échantillonnage perpendiculaire (mm). Défaut = stepMm. */
  perpStepMm?: number;
  /**
   * Normale du plan dans lequel on prend la perpendiculaire (la perpendiculaire
   * = tangente × normale). Défaut [0,0,1] (plan axial). Doit être ~unitaire.
   */
  planeNormal?: Vec3;
}

export interface CprImage {
  /** Largeur (échantillons le long de la courbe). */
  width: number;
  /** Hauteur (échantillons perpendiculaires). */
  height: number;
  /** Données scalaires (HU) en row-major : index = x + y*width. */
  data: Float32Array;
}

/**
 * Construit l'image CPR « étirée » (stretched) en échantillonnant le volume le
 * long de la courbe (axe x) et perpendiculairement (axe y).
 *
 * @param scalars Volume scalaire (HU), ordre x + y*nx + z*nx*ny.
 * @param dims    [nx, ny, nz].
 * @param origin  Origine monde (mm) du voxel (0,0,0).
 * @param spacing Spacing (mm) par axe.
 * @param points  Centerline (points monde mm) — ≥ 2.
 *
 * Robuste : entrées invalides → image 0×0 (data vide). Aucune exception.
 */
export function buildCprImage(
  scalars: ArrayLike<number>,
  dims: Vec3,
  origin: Vec3,
  spacing: Vec3,
  points: readonly Vec3[],
  options?: CprOptions
): CprImage {
  const empty: CprImage = { width: 0, height: 0, data: new Float32Array(0) };
  const step = options?.stepMm && options.stepMm > 0 ? options.stepMm : 1;
  const halfWidth =
    options?.halfWidthMm && options.halfWidthMm > 0 ? options.halfWidthMm : 20;
  const perpStep =
    options?.perpStepMm && options.perpStepMm > 0 ? options.perpStepMm : step;
  const planeNormal = normalize(options?.planeNormal ?? [0, 0, 1]);

  const samples = resampleCenterline(points, step);
  if (samples.length < 1) return empty;

  // Nombre de lignes perpendiculaires : de -halfWidth à +halfWidth par perpStep.
  const halfRows = Math.max(1, Math.round(halfWidth / perpStep));
  const height = halfRows * 2 + 1; // ligne centrale incluse
  const width = samples.length;
  const data = new Float32Array(width * height);

  for (let x = 0; x < width; x++) {
    const { position, tangent } = samples[x];
    // Perpendiculaire dans le plan = tangente × normale_du_plan.
    let perp = normalize(cross(tangent, planeNormal));
    // Si tangente ∥ normale (perp nul), repli sur un axe arbitraire du plan.
    if (perp[0] === 0 && perp[1] === 0 && perp[2] === 0) {
      perp = normalize(cross(tangent, [1, 0, 0]));
      if (perp[0] === 0 && perp[1] === 0 && perp[2] === 0) {
        perp = normalize(cross(tangent, [0, 1, 0]));
      }
    }
    for (let r = -halfRows; r <= halfRows; r++) {
      const off = r * perpStep;
      const wx = position[0] + perp[0] * off;
      const wy = position[1] + perp[1] * off;
      const wz = position[2] + perp[2] * off;
      const [ix, iy, iz] = worldToIndex([wx, wy, wz], origin, spacing);
      const hu = sampleVolumeTrilinear(scalars, dims, ix, iy, iz);
      const y = r + halfRows;
      data[x + y * width] = hu;
    }
  }

  return { width, height, data };
}

/**
 * Mappe une image CPR (HU) vers un buffer RGBA 8 bits (Uint8ClampedArray) via
 * une fenêtre largeur/centre (WW/WC), pour un rendu direct sur un <canvas>
 * (`putImageData`). PUR : aucune dépendance DOM (on renvoie le buffer brut).
 */
export function cprImageToRgba(
  img: CprImage,
  wc: number,
  ww: number
): Uint8ClampedArray {
  const width = ww > 0 ? ww : 1;
  const low = wc - width / 2;
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i++) {
    let g = ((img.data[i] - low) / width) * 255;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    const o = i * 4;
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}
