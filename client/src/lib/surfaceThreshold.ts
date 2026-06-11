// Presets de seuil pour le rendu surfacique (iso-surface), à la manière du menu
// « 3D Surface Rendering » de Horos / OsiriX.
//
// Rappel : un rendu surfacique extrait une SURFACE (maillage, typ. via Marching
// Cubes) à une valeur d'iso-contour donnée. Chaque voxel du volume est classé
// « dedans » ou « dehors » selon qu'il dépasse ou non ce seuil (isoValue). En
// CT, les valeurs sont en unités Hounsfield (HU) ; le seuil choisit le tissu :
//   • Os (bone)        : HU ≈ 300 et plus
//   • Os dense / dentaire : HU ≈ 500
//   • Peau (skin)      : HU ≈ −300 (interface air/tissu)
//   • Poumon (lung)    : HU ≈ −500 (parenchyme aéré)
//   • Tissu mou (soft) : HU ≈ 50
//   • Angio / contraste vasculaire : HU ≈ 200
//
// La convention CT est : air ≈ −1000, eau = 0, os spongieux 300+, os cortical
// 700+. La « peau » est la transition air→tissu, d'où un seuil négatif.
//
// Pour MR / PET, il n'existe pas d'échelle absolue universelle ; on fournit un
// seuil générique relatif (l'idéal restant un réglage interactif par série).
//
// Module 100 % PUR : aucune dépendance DOM / Cornerstone / vtk / I/O. On ne
// manipule que des données et des fonctions déterministes, testables hors
// navigateur.

/** Modalité DICOM ciblée par un preset surfacique (sous-ensemble utile). */
export type SurfaceModality = "CT" | "MR" | "PT" | "ANY";

/** Un preset de seuil d'iso-surface nommé. */
export interface SurfacePreset {
  /** Identifiant stable (slug) pour la persistance / sélection. */
  id: string;
  /** Libellé affiché (français), proche des intitulés Horos. */
  label: string;
  /** Modalité concernée (`ANY` = applicable à toute modalité). */
  modality: SurfaceModality;
  /**
   * Valeur d'iso-contour : un voxel appartient à la surface s'il est ≥ isoValue.
   * En CT, exprimée en unités Hounsfield (HU).
   */
  isoValue: number;
}

/**
 * Catalogue des presets surfaciques. L'ordre est celui d'affichage souhaité
 * dans l'UI, regroupé par modalité (CT en tête, le plus courant en surfacique).
 *
 * Valeurs CT (HU) selon les usages radiologiques courants :
 *   • Peau (skin)         : −300  (interface air/tissu)
 *   • Poumon (lung)       : −500  (parenchyme aéré)
 *   • Tissu mou (soft)    :   50
 *   • Angio (vasculaire)  :  200
 *   • Os (bone)           :  300
 *   • Os dense / dentaire :  500
 */
export const SURFACE_PRESETS: readonly SurfacePreset[] = [
  // ── CT ─────────────────────────────────────────────────────────────────────
  { id: "ct-skin", label: "Peau (CT)", modality: "CT", isoValue: -300 },
  { id: "ct-lung", label: "Poumon (CT)", modality: "CT", isoValue: -500 },
  { id: "ct-soft", label: "Tissu mou (CT)", modality: "CT", isoValue: 50 },
  { id: "ct-angio", label: "Angio (CT)", modality: "CT", isoValue: 200 },
  { id: "ct-bone", label: "Os (CT)", modality: "CT", isoValue: 300 },
  {
    id: "ct-bone-dense",
    label: "Os dense / dentaire (CT)",
    modality: "CT",
    isoValue: 500,
  },
  // ── MR ─────────────────────────────────────────────────────────────────────
  {
    id: "mr-generic",
    label: "Surface générique (MR)",
    modality: "MR",
    isoValue: 100,
  },
  // ── PET ────────────────────────────────────────────────────────────────────
  {
    id: "pt-generic",
    label: "Surface générique (PET)",
    modality: "PT",
    isoValue: 1,
  },
];

/**
 * Classe un voxel pour le rendu surfacique : `true` s'il appartient à la
 * surface (valeur ≥ isoValue), `false` sinon. Convention « ≥ » (et non « > »)
 * cohérente avec Marching Cubes où le seuil est inclusif côté intérieur.
 *
 * Robuste : si `value` ou `isoValue` n'est pas un nombre fini (NaN, Infinity),
 * renvoie `false` — un voxel non mesurable n'est jamais inclus dans la surface.
 */
export function classifyVoxel(value: number, isoValue: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(isoValue)) return false;
  return value >= isoValue;
}

/**
 * Renvoie le seuil d'iso-surface suggéré par défaut pour une modalité donnée.
 *
 * - CT  → seuil « Os » (300 HU), le rendu surfacique le plus courant.
 * - MR  → seuil générique.
 * - PT  → seuil générique.
 * - tout autre / inconnu → repli sur le seuil « Os » CT (valeur la plus utile
 *   pour un rendu surfacique générique).
 *
 * La comparaison de modalité est insensible à la casse et aux espaces.
 */
export function suggestIsoForModality(
  modality: string | null | undefined
): number {
  const m = String(modality ?? "")
    .trim()
    .toUpperCase();
  switch (m) {
    case "CT":
      return preset("ct-bone").isoValue;
    case "MR":
      return preset("mr-generic").isoValue;
    case "PT":
    case "PET":
      return preset("pt-generic").isoValue;
    default:
      return preset("ct-bone").isoValue;
  }
}

/**
 * Retourne les presets applicables à une modalité (ceux de la modalité plus les
 * presets `ANY`). Modalité inconnue → uniquement les presets `ANY`. La
 * comparaison est insensible à la casse / aux espaces ; `PET` est traité comme
 * `PT`.
 */
export function presetsForModality(
  modality: string | null | undefined
): readonly SurfacePreset[] {
  let m = String(modality ?? "")
    .trim()
    .toUpperCase();
  if (m === "PET") m = "PT";
  return SURFACE_PRESETS.filter(p => p.modality === "ANY" || p.modality === m);
}

/** Recherche interne d'un preset par id (présence garantie pour les ids fixes). */
function preset(id: string): SurfacePreset {
  const found = SURFACE_PRESETS.find(p => p.id === id);
  // Les ids passés ici sont des littéraux internes : ils existent toujours.
  if (!found) {
    throw new Error(`Preset surfacique inconnu : ${id}`);
  }
  return found;
}

/** Recherche publique d'un preset par id, ou `null` si absent. */
export function getSurfacePresetById(
  id: string | null | undefined
): SurfacePreset | null {
  if (id === null || id === undefined) return null;
  return SURFACE_PRESETS.find(p => p.id === id) ?? null;
}
