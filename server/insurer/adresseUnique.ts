// Même forme conservatrice qu'`estAdresseUnique` de `server/_core/emailAllowList.ts`
// (pas d'export partagé : ce module est dédié à l'ingestion assureur, cf.
// convention déjà suivie par les copies locales d'`esc()` dans ce dossier).
const FORME_ADRESSE_UNIQUE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Normalise une adresse de réponse assureur en UNE SEULE adresse plausible,
 * ou `null` si `s` n'en est pas une (vide, liste séparée par virgule/point-
 * virgule/espace, forme d'affichage avec chevrons, plusieurs "@"…).
 *
 * Point d'entrée de la garde contre le smuggling de destinataire (audit C1) :
 * `extraction.adresseReponse` est lu par le LLM dans le CORPS du mail entrant
 * — texte libre, attaquant-influençable (l'assureur prétendu peut écrire
 * n'importe quoi). Une chaîne comme `"attacker@evil.com, dossier@suva.ch"`
 * passerait le contrôle de domaine d'`isAllowedRecipient` (basé sur le
 * DERNIER "@") et partirait, via `nodemailer`, vers les DEUX adresses. En
 * normalisant ICI, à l'ingestion, `adresseReponse` ne peut plus jamais
 * porter qu'une adresse unique (ou `null`) pour tout le reste du pipeline.
 * Fonction pure.
 */
export function normaliserAdresseUnique(
  s: string | null | undefined
): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/[,;<>\s]/.test(t)) return null;
  if ((t.match(/@/g) ?? []).length !== 1) return null;
  return FORME_ADRESSE_UNIQUE.test(t) ? t : null;
}
