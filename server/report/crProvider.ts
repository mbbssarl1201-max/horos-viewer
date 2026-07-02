/**
 * Sélection du moteur de GÉNÉRATION DE CR (pré-analyse vision).
 *
 * Historique (« auto ») : Infomaniak (CH, nLPD natif) prioritaire dès que sa clé
 * est présente, puis Claude (sous garde consentement/DPA), sinon modèle local.
 * `CR_PROVIDER=claude` permet de router le CR vers Claude (ex. Fable 5, meilleur
 * raisonnement) SANS retirer la clé Infomaniak — qui reste utilisée par les
 * autres chemins vision. Fonction pure (testable) ; les gardes nLPD (consentement
 * DPA pour Claude) sont dans `claudeUsable`, calculé par l'appelant.
 */
export type CrBackend = "infomaniak" | "claude" | "local";

export function pickCrProvider(opts: {
  crProvider: string;
  claudeUsable: boolean;
  infomaniakUsable: boolean;
}): CrBackend {
  const pref = (opts.crProvider || "auto").toLowerCase();
  if (pref === "claude" && opts.claudeUsable) return "claude";
  if (pref === "infomaniak" && opts.infomaniakUsable) return "infomaniak";
  // « auto » et replis : comportement historique — Infomaniak d'abord.
  if (opts.infomaniakUsable) return "infomaniak";
  if (opts.claudeUsable) return "claude";
  return "local";
}
