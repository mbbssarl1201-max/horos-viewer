// Logique PURE de la segmentation (pinceau / gomme / effacement). Sans moteur
// Cornerstone ni DOM, pour rester testable : le composant CornerstoneViewer
// branche ces résolveurs sur l'API réelle (`@cornerstonejs/tools`).
//
// MVP CÔTÉ CLIENT UNIQUEMENT — la segmentation est un labelmap en mémoire, jamais
// persisté (aucun appel `server/`). Elle disparaît au rechargement / changement
// de série, ce qui est le périmètre voulu.

/** Ids des outils de la barre qui correspondent à la segmentation. */
export const SEGMENTATION_TOOL_IDS = ["brush", "eraser"] as const;
export type SegmentationToolId = (typeof SEGMENTATION_TOOL_IDS)[number];

/**
 * Stratégies du BrushTool (v4.22.x) pour un viewport 2D (cercle). Le pinceau et
 * la gomme partagent UNE SEULE instance de BrushTool ; on bascule la stratégie
 * active selon l'outil choisi dans la barre.
 */
export const BRUSH_FILL_STRATEGY = "FILL_INSIDE_CIRCLE";
export const BRUSH_ERASE_STRATEGY = "ERASE_INSIDE_CIRCLE";

/**
 * Vrai si l'id d'outil de la barre est un outil de segmentation (pinceau/gomme).
 * Sert au composant pour router ces ids vers le BrushTool.
 */
export function isSegmentationTool(
  toolId: string
): toolId is SegmentationToolId {
  return (SEGMENTATION_TOOL_IDS as readonly string[]).includes(toolId);
}

/**
 * Stratégie de pinceau à activer pour un id d'outil donné.
 * - "brush"  → remplit (peint le segment actif)
 * - "eraser" → efface (retire le segment sous le curseur)
 * Tout autre id renvoie `null` : ce n'est pas un outil de segmentation, l'appelant
 * ne doit pas toucher au BrushTool.
 */
export function resolveBrushStrategy(toolId: string): string | null {
  if (toolId === "brush") return BRUSH_FILL_STRATEGY;
  if (toolId === "eraser") return BRUSH_ERASE_STRATEGY;
  return null;
}

/** Index de segment actif par défaut (1 = premier segment ; 0 = fond/effacé). */
export const DEFAULT_SEGMENT_INDEX = 1;

/** Taille de pinceau par défaut (rayon en pixels, cf. config BrushTool). */
export const DEFAULT_BRUSH_SIZE = 25;
export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 100;

/** Borne une taille de pinceau dans l'intervalle autorisé (entrées dégénérées
 *  comprises : NaN → défaut). */
export function clampBrushSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_BRUSH_SIZE;
  return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Math.round(size)));
}

/**
 * Id de segmentation stable pour un viewport donné. Chaque cellule (viewport)
 * possède son propre labelmap, comme pour le moteur de rendu / tool group, afin
 * que la mosaïque multi-viewports ne partage pas un labelmap.
 */
export function segmentationIdForViewport(viewportId: string): string {
  return `SEG_${viewportId}`;
}
