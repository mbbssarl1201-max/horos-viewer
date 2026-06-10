/**
 * Presets de rendu volumique 3D — logique pure (testable sans le moteur).
 *
 * Chaque entrée référence un preset STANDARD de VTK.js exposé par Cornerstone3D
 * sous `cornerstone.CONSTANTS.VIEWPORT_PRESETS` (transfer functions bien réglées).
 * On garde uniquement le `name` du preset (chaîne) + un libellé clinique FRANÇAIS,
 * pour ne PAS importer le moteur ici (et donc pouvoir tester ce module isolément).
 *
 * `mip: true` → projection d'intensité maximale (blend MAXIMUM_INTENSITY_BLEND),
 * pas un simple transfer function.
 */
export interface VolumePreset3D {
  /** Id stable utilisé par l'UI/state. */
  id: string;
  /** Libellé clinique français affiché à l'utilisateur. */
  label: string;
  /** Nom du preset VTK standard (doit exister dans VIEWPORT_PRESETS). */
  preset: string;
  /** Projection d'intensité maximale. */
  mip: boolean;
}

/**
 * Liste des presets cliniques exposés dans la barre d'outils 3D.
 * Les `preset` correspondent à des noms présents dans VIEWPORT_PRESETS de
 * @cornerstonejs/core v4.x (vérifié dans node_modules au moment de l'écriture).
 */
export const PRESETS_3D: VolumePreset3D[] = [
  { id: "os", label: "Os", preset: "CT-Bone", mip: false },
  { id: "os-detail", label: "Os détaillé", preset: "CT-Bones", mip: false },
  { id: "mous", label: "Tissus mous", preset: "CT-Soft-Tissue", mip: false },
  { id: "muscle", label: "Muscle", preset: "CT-Muscle", mip: false },
  {
    id: "angio",
    label: "Angio coronaire",
    preset: "CT-Coronary-Arteries-2",
    mip: false,
  },
  { id: "cardiaque", label: "Cœur", preset: "CT-Cardiac", mip: false },
  {
    id: "vaisseaux",
    label: "Vaisseaux thoraciques",
    preset: "CT-Chest-Vessels",
    mip: false,
  },
  { id: "poumon", label: "Poumon", preset: "CT-Lung", mip: false },
  { id: "aorte", label: "Anévrisme aortique", preset: "CT-AAA", mip: false },
  { id: "air", label: "Voies aériennes", preset: "CT-Air", mip: false },
  { id: "irm", label: "IRM standard", preset: "MR-Default", mip: false },
  { id: "mip", label: "MIP", preset: "CT-MIP", mip: true },
];

/** Id du preset par défaut (osseux — rendu le plus parlant en CT). */
export const DEFAULT_PRESET_3D_ID = "os";

/** Retourne le preset par son id, avec repli sur le défaut (Os). */
export function presetParId(id: string | undefined): VolumePreset3D {
  return (
    PRESETS_3D.find(p => p.id === (id ?? DEFAULT_PRESET_3D_ID)) ?? PRESETS_3D[0]
  );
}

/**
 * Filtre la liste pour ne garder que les presets RÉELLEMENT disponibles dans
 * les VIEWPORT_PRESETS installés (repli gracieux si un nom a disparu d'une
 * future version). `availableNames` = noms exposés par CONSTANTS.VIEWPORT_PRESETS.
 * On conserve toujours MIP (géré par blend mode, pas par transfer function).
 */
export function presetsDisponibles(
  availableNames: string[] | undefined | null
): VolumePreset3D[] {
  if (!availableNames || availableNames.length === 0) return PRESETS_3D;
  const set = new Set(availableNames);
  const filtres = PRESETS_3D.filter(p => p.mip || set.has(p.preset));
  // Ne jamais renvoyer une liste vide : repli sur la liste complète.
  return filtres.length > 0 ? filtres : PRESETS_3D;
}

/** Vrai si le preset (par nom VTK) existe dans la liste fournie. */
export function presetExiste(
  presetName: string,
  availableNames: string[] | undefined | null
): boolean {
  if (!availableNames) return false;
  return availableNames.includes(presetName);
}
