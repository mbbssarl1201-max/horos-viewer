/** Une série est reconstructible en volume si elle a au moins 2 coupes. PUR. */
export function isReconstructable(
  imageIds: readonly string[] | undefined
): boolean {
  return !!imageIds && imageIds.length >= 2;
}

/** Borne l'épaisseur de dalle (mm) dans [0, max]. PUR. */
export function clampSlabThickness(mm: number, max: number): number {
  if (!Number.isFinite(mm)) return 0;
  return Math.max(0, Math.min(max, mm));
}
