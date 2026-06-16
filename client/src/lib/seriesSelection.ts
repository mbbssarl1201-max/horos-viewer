/**
 * Vrai si l'auto-sélection de série doit (re)choisir une série : soit rien n'est
 * sélectionné, soit la série actuellement sélectionnée n'appartient PAS à la
 * liste de l'étude courante (cas du changement d'étude où l'ancien id persiste
 * → empêche d'afficher les coupes d'un autre patient). Fonction pure.
 */
export function shouldReselectSeries(
  selectedSeries: number | null | undefined,
  seriesList: readonly { id: number }[] | null | undefined
): boolean {
  if (!seriesList || seriesList.length === 0) return false;
  if (selectedSeries == null) return true;
  return !seriesList.some(s => s.id === selectedSeries);
}
