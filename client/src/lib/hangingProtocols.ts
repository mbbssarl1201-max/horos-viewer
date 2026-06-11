/**
 * Protocoles d'accrochage (« hanging protocols ») déclaratifs.
 *
 * Un protocole associe une MODALITÉ (et, en option, des mots-clés de description
 * de série / partie du corps) à une configuration par défaut du visualiseur :
 *   - disposition (layout) : 1x1 / 1x2 / 2x2,
 *   - preset de fenêtrage (W/L) à appliquer,
 *   - outil initial sélectionné.
 *
 * Le but est de présenter une étude « correctement accrochée » dès l'ouverture
 * (CT thorax → poumon, CT crâne → cerveau, os → fenêtre osseuse…), tout en
 * laissant l'utilisateur reprendre la main : on applique le protocole UNE SEULE
 * FOIS au chargement, jamais en réaction à un réglage manuel.
 *
 * Module PUR (aucun effet de bord) → testable sous `client/src/lib/**`.
 */

import type { ViewportLayout } from "./viewportLayout";

// Nom de preset W/L — doit correspondre à un `name` de WL_PRESETS (Viewer.tsx).
export type WlPresetName =
  | "Default"
  | "Bone"
  | "Lung"
  | "Brain"
  | "Abdomen"
  | "Liver"
  | "Mediastinum";

// Outil initial — doit correspondre à un `id` de VIEWER_TOOLS (Viewer.tsx).
export type ViewerToolId = "wwwl" | "zoom" | "pan" | "scroll" | "length";

export interface HangingProtocol {
  id: string;
  label: string;
  layout: ViewportLayout;
  wlPreset: WlPresetName;
  initialTool: ViewerToolId;
}

interface HangingProtocolRule extends HangingProtocol {
  // Modalité visée (en MAJUSCULES). "*" = toute modalité (repli).
  modality: string;
  // Mots-clés (minuscules) recherchés dans la description de série / body part.
  // Une règle avec mots-clés est PRIORITAIRE sur la règle générique de sa
  // modalité. Vide => règle générique de la modalité.
  keywords: string[];
}

// Règles ordonnées : les plus SPÉCIFIQUES (avec mots-clés) d'abord pour chaque
// modalité, puis les génériques. `pickHangingProtocol` renvoie la 1re qui colle.
const RULES: HangingProtocolRule[] = [
  // ── CT ────────────────────────────────────────────────────────────────────
  {
    id: "ct-chest",
    label: "CT thorax (fenêtre poumon)",
    modality: "CT",
    keywords: ["chest", "thorax", "lung", "poumon", "pulmon", "thoracic"],
    layout: "1x1",
    wlPreset: "Lung",
    initialTool: "scroll",
  },
  {
    id: "ct-head",
    label: "CT crâne (fenêtre cerveau)",
    modality: "CT",
    keywords: [
      "head",
      "brain",
      "crane",
      "crâne",
      "cerveau",
      "cerebral",
      "skull",
    ],
    layout: "1x1",
    wlPreset: "Brain",
    initialTool: "scroll",
  },
  {
    id: "ct-abdomen",
    label: "CT abdomen",
    modality: "CT",
    keywords: ["abdomen", "abdo", "pelvis", "pelvien", "liver", "foie"],
    layout: "1x1",
    wlPreset: "Abdomen",
    initialTool: "scroll",
  },
  {
    id: "ct-bone",
    label: "CT os (fenêtre osseuse)",
    modality: "CT",
    keywords: [
      "bone",
      "os",
      "osseux",
      "rachis",
      "spine",
      "knee",
      "genou",
      "hip",
      "hanche",
    ],
    layout: "1x1",
    wlPreset: "Bone",
    initialTool: "scroll",
  },
  {
    id: "ct-default",
    label: "CT (par défaut)",
    modality: "CT",
    keywords: [],
    layout: "1x1",
    wlPreset: "Default",
    initialTool: "scroll",
  },
  // ── IRM ─────────────────────────────────────────────────────────────────
  {
    id: "mr-default",
    label: "IRM (par défaut)",
    modality: "MR",
    keywords: [],
    layout: "1x1",
    wlPreset: "Default",
    initialTool: "scroll",
  },
  // ── Radio / mammo (image unique → outil de mesure prêt) ───────────────────
  {
    id: "xr-default",
    label: "Radiographie",
    modality: "CR",
    keywords: [],
    layout: "1x1",
    wlPreset: "Default",
    initialTool: "wwwl",
  },
];

// Repli ultime quand aucune règle ne correspond à la modalité.
export const DEFAULT_HANGING_PROTOCOL: HangingProtocol = {
  id: "fallback",
  label: "Par défaut",
  layout: "1x1",
  wlPreset: "Default",
  initialTool: "wwwl",
};

/**
 * Choisit le protocole d'accrochage pour une (modalité, description de série).
 *
 * Stratégie : on cherche d'abord une règle de la modalité dont un mot-clé
 * apparaît dans la description ; sinon la règle générique de la modalité ;
 * sinon le repli par défaut. Insensible à la casse, robuste aux valeurs
 * absentes (modalité/description vides → repli).
 */
export function pickHangingProtocol(
  modality: string | null | undefined,
  seriesDescription: string | null | undefined
): HangingProtocol {
  const mod = (modality || "").trim().toUpperCase();
  if (!mod) return DEFAULT_HANGING_PROTOCOL;

  const desc = (seriesDescription || "").toLowerCase();
  const forModality = RULES.filter(r => r.modality === mod);

  // 1) Règle spécifique : un mot-clé présent dans la description.
  const keyworded = forModality.find(
    r => r.keywords.length > 0 && r.keywords.some(k => desc.includes(k))
  );
  if (keyworded) return toProtocol(keyworded);

  // 2) Règle générique de la modalité (keywords vides).
  const generic = forModality.find(r => r.keywords.length === 0);
  if (generic) return toProtocol(generic);

  // 3) Repli.
  return DEFAULT_HANGING_PROTOCOL;
}

function toProtocol(r: HangingProtocolRule): HangingProtocol {
  return {
    id: r.id,
    label: r.label,
    layout: r.layout,
    wlPreset: r.wlPreset,
    initialTool: r.initialTool,
  };
}
