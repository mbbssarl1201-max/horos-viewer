// Logique PURE de disposition multi-viewports (1x1 / 1x2 / 2x2). Sans DOM ni
// moteur de rendu, donc testable : l'UI consomme `layoutCellCount` (nombre de
// cellules à monter) et `layoutGridClass` (classes Tailwind de la grille), et
// `clampActiveCell` borne l'index de la cellule active quand on change de layout.

/** Dispositions de viewports proposées dans la barre d'outils. */
export const VIEWPORT_LAYOUTS = ["1x1", "1x2", "2x2"] as const;
export type ViewportLayout = (typeof VIEWPORT_LAYOUTS)[number];

/** Disposition par défaut : viewport unique, comportement historique. */
export const DEFAULT_VIEWPORT_LAYOUT: ViewportLayout = "1x1";

/** Nombre de cellules (viewports) à monter pour une disposition donnée. */
export function layoutCellCount(layout: ViewportLayout): number {
  switch (layout) {
    case "1x2":
      return 2;
    case "2x2":
      return 4;
    case "1x1":
    default:
      return 1;
  }
}

/** Classes Tailwind décrivant la grille CSS pour une disposition donnée. */
export function layoutGridClass(layout: ViewportLayout): string {
  switch (layout) {
    case "1x2":
      return "grid grid-cols-2 grid-rows-1";
    case "2x2":
      return "grid grid-cols-2 grid-rows-2";
    case "1x1":
    default:
      return "grid grid-cols-1 grid-rows-1";
  }
}

/**
 * Borne l'index de la cellule active dans [0, count-1] quand on change de
 * disposition (ex. on était sur la cellule 3 en 2x2 puis on repasse en 1x1).
 * Robuste aux entrées dégénérées.
 */
export function clampActiveCell(
  active: number,
  layout: ViewportLayout
): number {
  const count = layoutCellCount(layout);
  if (!Number.isFinite(active) || active < 0) return 0;
  if (active > count - 1) return count - 1;
  return Math.floor(active);
}
