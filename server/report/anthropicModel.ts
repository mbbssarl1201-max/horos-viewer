/**
 * Prédicat pur (sans dépendance SDK) : le modèle appartient-il à la famille
 * Fable/Mythos ? Ces modèles peuvent renvoyer `stop_reason:"refusal"` (voir
 * `anthropicClient.ts`). Isolé ici pour être testable et importable partout.
 */
export const REFUSAL_FALLBACK_MODEL = "claude-opus-4-8";

export function isFableModel(model: string | null | undefined): boolean {
  return /^claude-(fable|mythos)-/i.test(model ?? "");
}
