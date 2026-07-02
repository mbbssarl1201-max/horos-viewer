/**
 * Albums rapides « Today <modalité> » façon Horos (Today CT/MR/US…). PURS.
 * On combine « date d'étude = aujourd'hui » et « modalité = X » en un seul clic.
 */

/** Vrai si `ms` tombe dans la journée locale de `now`. */
export function isTodayMs(ms: number | null, now: number): boolean {
  if (ms == null) return false;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return ms >= startMs && ms < startMs + 24 * 3600 * 1000;
}

/** Vrai si l'étude est de la modalité cible ET datée d'aujourd'hui. */
export function matchesTodayModality(
  targetModality: string,
  study: { modality?: string | null } | null | undefined,
  studyMs: number | null,
  now: number
): boolean {
  if (!study) return false;
  if (
    String(study.modality ?? "").toUpperCase() !== targetModality.toUpperCase()
  )
    return false;
  return isTodayMs(studyMs, now);
}
