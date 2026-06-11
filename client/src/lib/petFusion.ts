/**
 * Logique PURE de la fusion PET-CT (overlay d'un volume PET coloré sur le CT en
 * niveaux de gris dans les viewports MPR/3D de Cornerstone3D).
 *
 * Aucune dépendance Cornerstone / DOM : juste de la sélection de série, le
 * bornage de l'opacité et le choix de colormap. La couche d'affichage
 * (VolumeViewer) consomme ces helpers et appelle `addVolumesToViewports` +
 * `viewport.setProperties({ colormap }, petVolumeId)`.
 */

/** Modalité DICOM d'une série PET (Positron Emission Tomography). */
export const PET_MODALITY = "PT";

/** Forme minimale d'une série telle que listée côté client. */
export interface SeriesLike {
  id: number;
  modality?: string | null;
  seriesDescription?: string | null;
  seriesNumber?: number | null;
}

/**
 * Détecte les séries PET d'une étude (modality === "PT", insensible à la casse
 * et aux espaces). Retourne la liste filtrée (vide si aucune).
 */
export function findPetSeries(
  seriesList: readonly SeriesLike[] | null | undefined
): SeriesLike[] {
  if (!seriesList) return [];
  return seriesList.filter(
    s => (s.modality ?? "").trim().toUpperCase() === PET_MODALITY
  );
}

/** Y a-t-il au moins une série PET exploitable pour la fusion ? */
export function hasPetSeries(
  seriesList: readonly SeriesLike[] | null | undefined
): boolean {
  return findPetSeries(seriesList).length > 0;
}

/**
 * Borne l'opacité de fusion dans [0, 1]. Toute entrée non finie → 0 (PET masqué,
 * choix sûr : on ne superpose rien si la valeur est invalide). Les pourcentages
 * 0..100 sont aussi acceptés (auto-normalisés si > 1).
 */
export function clampFusionOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let v = value;
  if (v > 1) v = v / 100; // tolère un pourcentage 0..100
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Colormaps proposées pour le volume PET. Les `name` correspondent à des presets
 * VTK.js enregistrés (vérifiés présents dans la version installée) — utilisables
 * tels quels dans `setProperties({ colormap: { name } })`.
 *
 * « Hot Iron » (PET classique) → preset VTK « 2hot » ; on fournit aussi des
 * alternatives perceptuellement uniformes (Inferno/Magma) et le rainbow PET.
 */
export interface PetColormapOption {
  /** Identifiant stable utilisé par l'UI. */
  id: string;
  /** Libellé FR affiché. */
  label: string;
  /** Nom du preset VTK.js (passé tel quel à Cornerstone). */
  vtkName: string;
}

export const PET_COLORMAPS: PetColormapOption[] = [
  { id: "hot", label: "Hot Iron (PET)", vtkName: "2hot" },
  { id: "inferno", label: "Inferno", vtkName: "Inferno (matplotlib)" },
  { id: "magma", label: "Magma", vtkName: "Magma (matplotlib)" },
  { id: "rainbow", label: "Arc-en-ciel (HSV)", vtkName: "hsv" },
  { id: "jet", label: "Jet", vtkName: "jet" },
];

/** Colormap PET par défaut (Hot Iron). */
export const DEFAULT_PET_COLORMAP_ID = "hot";

/** Résout l'id de colormap PET → nom VTK ; repli sur le défaut si inconnu. */
export function petColormapVtkName(id: string | undefined): string {
  const found = PET_COLORMAPS.find(c => c.id === id);
  return (found ?? PET_COLORMAPS[0]).vtkName;
}
