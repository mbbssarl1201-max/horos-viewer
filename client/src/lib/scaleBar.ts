const NICE_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500];

/**
 * Règle calibrée : choisit un pas « rond » (mm) dont la longueur écran tient dans
 * ~1/4 de `lengthPx`. `pixelSpacingMm` = taille d'un pixel image en mm ; `zoom` =
 * facteur (px écran / px image). PUR. null si non calculable.
 */
export function computeScaleBar(
  pixelSpacingMm: number | null,
  zoom: number,
  lengthPx: number
): { barPx: number; labelMm: number } | null {
  if (!pixelSpacingMm || pixelSpacingMm <= 0 || zoom <= 0 || lengthPx <= 0)
    return null;
  const screenPxPerMm = zoom / pixelSpacingMm; // px écran par mm
  const maxBarPx = lengthPx / 4;
  let chosen = NICE_MM[0];
  for (const mm of NICE_MM) {
    if (mm * screenPxPerMm <= maxBarPx) chosen = mm;
    else break;
  }
  return { barPx: chosen * screenPxPerMm, labelMm: chosen };
}
