/**
 * Logique PURE du mode comparatif d'antériorités (étude courante + 1 antérieure
 * côte à côte). Sans DOM ni réseau, donc testable :
 *  - `clampPriorSlice` borne l'indice de coupe partagé au total de l'antériorité
 *    (les deux études n'ont pas le même nombre de coupes) ;
 *  - `pickPriorSeries` choisit la série à afficher à droite (même modalité que
 *    la courante si possible, sinon la première).
 */

/** Borne l'indice de coupe dans [0, priorTotal-1]. Dégénéré → 0. */
export function clampPriorSlice(
  currentSlice: number,
  priorTotal: number
): number {
  if (!Number.isFinite(priorTotal) || priorTotal <= 0) return 0;
  if (!Number.isFinite(currentSlice) || currentSlice < 0) return 0;
  return Math.min(Math.floor(currentSlice), priorTotal - 1);
}

export interface PriorSeriesLike {
  id: number;
  modality?: string | null;
}

/**
 * Série de l'antériorité à afficher : première série de MÊME modalité que la
 * courante si elle existe, sinon la première série, sinon null.
 */
export function pickPriorSeries(
  series: readonly PriorSeriesLike[] | null | undefined,
  currentModality?: string | null
): number | null {
  if (!series || series.length === 0) return null;
  const wanted = (currentModality ?? "").trim().toUpperCase();
  if (wanted) {
    const match = series.find(
      s => (s.modality ?? "").trim().toUpperCase() === wanted
    );
    if (match) return match.id;
  }
  return series[0].id;
}
