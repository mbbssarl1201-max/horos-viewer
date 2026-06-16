// Calcul de surface, périmètre et volume d'une ROI (menu « Compute Volume »).
//
// Une ROI fermée est un polygone simple dont les sommets sont donnés en
// coordonnées PIXEL (colonne, ligne). Pour obtenir des mesures physiques on
// applique le PixelSpacing DICOM `[ligne, colonne]` en mm/pixel (0028,0030) :
//   • surface  → formule du lacet (shoelace), en mm²
//   • périmètre → somme des longueurs des arêtes, en mm
//   • volume   → cumul des surfaces de coupes × espacement inter-coupes, en mm³
//
// Fonctions PURES et déterministes : aucune dépendance Cornerstone / DOM / I/O.
// On ne manipule que des nombres. Entrées dégénérées (< 3 sommets, spacing nul
// ou négatif) → 0, jamais NaN ni exception : l'appelant affiche « 0 » plutôt
// qu'une mesure fausse.

/** Sommet d'un polygone en coordonnées pixel : `[colonne, ligne]` (x, y). */
export type Point = [number, number];

/**
 * Espacement physique d'un pixel en mm, format DICOM PixelSpacing (0028,0030) :
 * `[rowSpacing, colSpacing]` = `[mm par ligne (axe y), mm par colonne (axe x)]`.
 */
export type PixelSpacing = [number, number];

/** Vrai si tous les nombres d'un point sont finis. */
function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/**
 * Surface d'un polygone fermé via la formule du lacet (shoelace), en mm².
 *
 * Les sommets sont en pixels `[col, row]` ; on les met à l'échelle physique
 * avec `pixelSpacing = [rowSpacing, colSpacing]` (x ← col×colSpacing,
 * y ← row×rowSpacing) AVANT le calcul, ce qui revient à multiplier l'aire
 * pixel par `rowSpacing×colSpacing`. Le polygone est implicitement refermé
 * (dernier sommet relié au premier).
 *
 * Robustesse : < 3 sommets, spacing ≤ 0 ou non fini, ou sommet non fini → 0.
 * Le résultat est TOUJOURS positif (valeur absolue : l'orientation horaire /
 * antihoraire n'affecte pas une surface physique).
 */
export function polygonArea(
  points: Point[],
  pixelSpacing: PixelSpacing
): number {
  const n = points.length;
  if (n < 3) return 0;

  const [rowSpacing, colSpacing] = pixelSpacing;
  if (
    !Number.isFinite(rowSpacing) ||
    !Number.isFinite(colSpacing) ||
    rowSpacing <= 0 ||
    colSpacing <= 0
  ) {
    return 0;
  }

  let twiceArea = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (!isFinitePoint(a) || !isFinitePoint(b)) return 0;
    // x = colonne × colSpacing, y = ligne × rowSpacing.
    const ax = a[0] * colSpacing;
    const ay = a[1] * rowSpacing;
    const bx = b[0] * colSpacing;
    const by = b[1] * rowSpacing;
    twiceArea += ax * by - bx * ay;
  }
  return Math.abs(twiceArea) / 2;
}

/**
 * Périmètre d'un polygone fermé en mm : somme des longueurs euclidiennes des
 * arêtes, dernier sommet relié au premier. Les pixels sont mis à l'échelle
 * physique via `pixelSpacing = [rowSpacing, colSpacing]`.
 *
 * Robustesse : < 2 sommets, spacing ≤ 0 ou non fini, ou sommet non fini → 0.
 * Avec exactement 2 sommets on renvoie 2× la longueur du segment (aller-retour),
 * cohérent avec un « polygone » dégénéré refermé.
 */
export function polygonPerimeter(
  points: Point[],
  pixelSpacing: PixelSpacing
): number {
  const n = points.length;
  if (n < 2) return 0;

  const [rowSpacing, colSpacing] = pixelSpacing;
  if (
    !Number.isFinite(rowSpacing) ||
    !Number.isFinite(colSpacing) ||
    rowSpacing <= 0 ||
    colSpacing <= 0
  ) {
    return 0;
  }

  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (!isFinitePoint(a) || !isFinitePoint(b)) return 0;
    const dx = (b[0] - a[0]) * colSpacing;
    const dy = (b[1] - a[1]) * rowSpacing;
    perimeter += Math.hypot(dx, dy);
  }
  return perimeter;
}

/**
 * Volume d'une pile de ROI (une surface par coupe) en mm³, par la méthode des
 * tranches (sommation des prismes) :
 *   volume = (Σ surface_coupe) × espacement_inter_coupes
 *
 * `areasMm2` est la liste des surfaces de chaque coupe (en mm², typiquement
 * issues de `polygonArea`), `sliceSpacingMm` est la distance entre coupes en mm
 * (SpacingBetweenSlices 0018,0088, ou pas de reconstruction). Les surfaces
 * non finies ou négatives sont ignorées (comptées 0).
 *
 * Robustesse : liste vide, spacing ≤ 0 ou non fini → 0.
 */
export function stackVolume(
  areasMm2: number[],
  sliceSpacingMm: number
): number {
  if (!Number.isFinite(sliceSpacingMm) || sliceSpacingMm <= 0) return 0;
  if (areasMm2.length === 0) return 0;

  let sum = 0;
  for (const area of areasMm2) {
    if (Number.isFinite(area) && area > 0) sum += area;
  }
  return sum * sliceSpacingMm;
}
