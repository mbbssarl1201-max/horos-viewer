/**
 * Déclenchement OPT-IN des notifications RIS sur les transitions d'étude.
 *
 * Sécurité / production : tant que RIS_NOTIFY_EMAIL n'est pas configuré,
 * `shouldNotify` renvoie toujours false → aucun e-mail n'est envoyé. Le
 * comportement actuel de la production est donc préservé jusqu'à activation
 * explicite par l'opérateur.
 */

/**
 * Décide si une transition de valeur (statut ou priorité) doit déclencher une
 * notification. On notifie uniquement quand :
 *  - une boîte RIS est configurée (`risEmail` non vide), ET
 *  - la nouvelle valeur fait partie des déclencheurs, ET
 *  - il s'agit d'une vraie TRANSITION (la valeur a changé).
 *
 * Fonction pure et testable.
 */
export function shouldNotify(
  prev: string | null | undefined,
  next: string | null | undefined,
  triggers: readonly string[],
  risEmail: string | null | undefined
): boolean {
  if (!risEmail) return false; // garde-fou opt-in
  if (!next) return false;
  if (prev === next) return false; // pas de transition
  return triggers.includes(next);
}

export const PRIORITY_TRIGGERS = ["stat", "urgent"] as const;
export const STATUS_TRIGGERS = ["finalized"] as const;
