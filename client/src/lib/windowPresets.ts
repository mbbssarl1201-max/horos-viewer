// Presets de fenêtrage (Window Level / Window Width) par modalité et région
// anatomique, à la manière de Horos / OsiriX.
//
// Rappel : une image en niveaux de Hounsfield (CT) ou en intensité (MR) couvre
// une plage très large ; on n'en affiche qu'une « fenêtre » mappée sur le noir
// → blanc de l'écran. Cette fenêtre est définie par :
//   • WC (Window Center, alias Window Level / WL) : le centre de la fenêtre.
//   • WW (Window Width)  : la largeur totale de la fenêtre.
// Les pixels < WC−WW/2 sont noirs, > WC+WW/2 sont blancs, le reste interpolé.
//
// Les valeurs CT ci-dessous sont des standards radiologiques en unités
// Hounsfield (HU). Pour le MR, WC/WW dépendent du scanner ; on fournit des
// presets génériques relatifs, l'idéal restant le « Default » issu des tags
// DICOM (WindowCenter 0028,1050 / WindowWidth 0028,1051) de chaque série.
//
// Module 100 % PUR : aucune dépendance DOM / Cornerstone / I/O. On ne manipule
// que des données et des fonctions déterministes, testables hors navigateur.

/** Modalité DICOM ciblée par un preset (sous-ensemble utile au fenêtrage). */
export type PresetModality = "CT" | "MR" | "PT" | "ANY";

/** Un preset de fenêtrage nommé. */
export interface WindowPreset {
  /** Identifiant stable (slug) pour la persistance / sélection. */
  id: string;
  /** Libellé affiché (français), proche des intitulés Horos. */
  label: string;
  /** Modalité concernée (`ANY` = applicable à toute modalité). */
  modality: PresetModality;
  /**
   * Window Center (WC / Window Level). `null` pour le preset « Default » dont
   * les valeurs proviennent des tags DICOM de la série (calculées au runtime).
   */
  wc: number | null;
  /** Window Width (WW). `null` pour « Default » (issu des tags DICOM). */
  ww: number | null;
}

/**
 * Catalogue des presets. L'ordre est celui d'affichage souhaité dans l'UI :
 * « Default » en tête (par modalité), puis les régions par convention Horos.
 *
 * Les valeurs CT (HU) suivent les usages radiologiques courants :
 *   • Abdomen / tissu mou : WC 40, WW 400
 *   • Tissu mou (soft)    : WC 40, WW 350
 *   • Foie (liver)        : WC 90, WW 150
 *   • Médiastin           : WC 50, WW 350
 *   • Poumon (lung)       : WC −600, WW 1500
 *   • Os (bone)           : WC 300, WW 1500
 *   • Os dense / CBCT     : WC 500, WW 2000
 *   • Cerveau (brain)     : WC 40, WW 80
 *   • Angio (vasculaire)  : WC 300, WW 600
 */
export const WINDOW_PRESETS: readonly WindowPreset[] = [
  // ── Default (par tags DICOM) ───────────────────────────────────────────────
  {
    id: "default",
    label: "Défaut (tags DICOM)",
    modality: "ANY",
    wc: null,
    ww: null,
  },

  // ── CT (unités Hounsfield) ─────────────────────────────────────────────────
  { id: "ct-abdomen", label: "Abdomen", modality: "CT", wc: 40, ww: 400 },
  { id: "ct-soft", label: "Tissu mou", modality: "CT", wc: 40, ww: 350 },
  { id: "ct-liver", label: "Foie", modality: "CT", wc: 90, ww: 150 },
  { id: "ct-mediastinum", label: "Médiastin", modality: "CT", wc: 50, ww: 350 },
  { id: "ct-lung", label: "Poumon", modality: "CT", wc: -600, ww: 1500 },
  { id: "ct-brain", label: "Cerveau", modality: "CT", wc: 40, ww: 80 },
  { id: "ct-bone", label: "Os", modality: "CT", wc: 300, ww: 1500 },
  { id: "ct-bone-dense", label: "Os dense", modality: "CT", wc: 500, ww: 2000 },
  { id: "ct-angio", label: "Angio", modality: "CT", wc: 300, ww: 600 },

  // ── MR (génériques relatifs ; préférer Default si tags présents) ───────────
  { id: "mr-default", label: "MR standard", modality: "MR", wc: 500, ww: 1000 },
  { id: "mr-brain", label: "Cerveau (MR)", modality: "MR", wc: 600, ww: 1200 },
  { id: "mr-soft", label: "Tissu mou (MR)", modality: "MR", wc: 400, ww: 800 },
] as const;

/** Normalise une modalité en majuscules, tolère espaces / casse / null. */
function normalizeModality(modality: unknown): string {
  if (modality === null || modality === undefined) return "";
  return String(modality).trim().toUpperCase();
}

/**
 * Renvoie les presets applicables à une modalité donnée. On inclut toujours
 * les presets `ANY` (ex. « Default »). Une modalité inconnue / absente ne
 * renvoie que les presets `ANY`. L'ordre du catalogue est préservé.
 *
 * Le tableau renvoyé est une NOUVELLE liste (filtrée) : l'appelant peut la
 * trier / muter sans affecter `WINDOW_PRESETS`.
 */
export function getPresetsForModality(modality: unknown): WindowPreset[] {
  const mod = normalizeModality(modality);
  return WINDOW_PRESETS.filter(p => p.modality === "ANY" || p.modality === mod);
}

/**
 * Recherche un preset par son `id`. Renvoie `undefined` si introuvable (id
 * absent / vide / inconnu). La comparaison est stricte sur l'id (slug stable).
 */
export function findPreset(id: unknown): WindowPreset | undefined {
  if (id === null || id === undefined) return undefined;
  const key = String(id);
  return WINDOW_PRESETS.find(p => p.id === key);
}
