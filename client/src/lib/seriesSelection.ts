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

/**
 * Une série est-elle un sous-produit TECHNIQUE (scanogramme/topogramme/
 * localizer/dose report/SUMMARY) à éviter comme série affichée par défaut ?
 * Aligné sur le filtre serveur (isDiagnosticSeries). Pure.
 */
function isTechnicalSeries(s: {
  seriesDescription?: string | null;
  modality?: string | null;
}): boolean {
  const modality = (s.modality ?? "").trim().toUpperCase();
  if (["SR", "PR", "KO", "DOC", "OT"].includes(modality)) return true;
  const desc = (s.seriesDescription ?? "").toLowerCase();
  return /scano|topogram|topogramme|localizer|localiser|scout|surview|dose\s*report|dose\s*info|patient\s*protocol|summary|screen\s*save|secondary\s*capture|key\s*image/.test(
    desc
  );
}

/**
 * Série à afficher PAR DÉFAUT à l'ouverture d'une étude : la série DIAGNOSTIQUE
 * la plus volumineuse (le médecin veut voir les vraies coupes, pas le
 * scanogramme de repérage de 2 images affiché en tête de liste). Repli sur la
 * 1re série si aucune n'est diagnostique. Renvoie un id, ou null si vide. Pure.
 */
export function pickDefaultSeries(
  seriesList:
    | readonly {
        id: number;
        seriesDescription?: string | null;
        modality?: string | null;
        numberOfInstances?: number | null;
      }[]
    | null
    | undefined
): number | null {
  if (!seriesList || seriesList.length === 0) return null;
  const diagnostic = seriesList.filter(s => !isTechnicalSeries(s));
  const pool = diagnostic.length > 0 ? diagnostic : seriesList;
  // La plus grosse série du pool (plus d'images = série de coupes principale).
  let best = pool[0];
  for (const s of pool) {
    if ((s.numberOfInstances ?? 0) > (best.numberOfInstances ?? 0)) best = s;
  }
  return best.id;
}
