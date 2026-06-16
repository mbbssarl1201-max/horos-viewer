// Logique de timing du ciné (boucle de lecture). Pure (sans moteur ni DOM) pour
// rester testable : un timer dans l'UI appelle nextCineIndex à chaque tick.

/** Cadences proposées dans l'UI (images/seconde). */
export const CINE_FPS_OPTIONS = [5, 10, 15, 24, 30] as const;
export const DEFAULT_CINE_FPS = 15;

/**
 * Index de la coupe suivante pour le ciné.
 * - loop = true (défaut) : revient à 0 après la dernière coupe.
 * - loop = false : reste sur la dernière coupe (lecture unique).
 * Robuste aux entrées dégénérées (total <= 0, current hors bornes).
 */
export function nextCineIndex(
  current: number,
  total: number,
  loop = true
): number {
  if (total <= 0) return 0;
  if (total === 1) return 0;
  const next = current + 1;
  if (next < total) return next;
  return loop ? 0 : total - 1;
}

/** Intervalle du timer (ms) pour une cadence donnée. Borne le fps à >= 1. */
export function fpsToIntervalMs(fps: number): number {
  return 1000 / Math.max(1, fps);
}
