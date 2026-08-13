// Forme conservatrice d'un mailbox UNIQUE — pas de virgule/point-virgule
// (liste), pas de chevrons (forme d'affichage "Nom <a@b.ch>"), pas d'espace
// ni de saut de ligne (repli d'en-tête), et exactement un "@". Rejette aussi
// une adresse à double "@" avant même le test de forme (cf. `estAdresseUnique`).
const FORME_ADRESSE_UNIQUE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Vrai si `email` est une SEULE adresse plausible — jamais une liste
 * (`a@b.ch, c@d.ch`), une forme d'affichage (`Nom <a@b.ch>`) ni une chaîne
 * comportant plusieurs "@". Garde de forme, indépendante de tout allow-list :
 * sert de première ligne de défense contre le smuggling de destinataire
 * (cf. audit C1 — `extraction.adresseReponse` de l'agent assureur, texte
 * libre attaquant-influençable, transmis tel quel à nodemailer `to`, qui
 * accepte une liste séparée par virgules).
 */
function estAdresseUnique(email: string): boolean {
  const t = email.trim();
  if (!t) return false;
  if (/[,;<>\s]/.test(t)) return false;
  if ((t.match(/@/g) ?? []).length !== 1) return false;
  return FORME_ADRESSE_UNIQUE.test(t);
}

/**
 * Vrai si l'adresse est autorisée comme destinataire d'un envoi PHI. Si
 * `allowedDomains` est vide → AUCUNE restriction (true). Sinon le domaine de
 * l'adresse (après @, en minuscules) doit figurer dans la liste. Adresse
 * malformée → false. Fonction pure.
 */
export function isAllowedRecipient(
  email: string,
  allowedDomains: readonly string[]
): boolean {
  if (allowedDomains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return allowedDomains.includes(domain);
}

/**
 * Garde renforcée (fail-closed) pour les envois PHI déclenchés par un chemin à
 * FAIBLE confiance — typiquement la voix Eva, où le domaine destinataire est
 * extrait de texte libre et donc exposé aux fautes de frappe. En production,
 * une allow-list VIDE refuse TOUT envoi (au lieu du fail-open de
 * `isAllowedRecipient`), pour qu'aucun compte rendu nominatif ne parte vers un
 * domaine arbitraire tant que les correspondants légitimes ne sont pas
 * explicitement déclarés. Hors production, comportement inchangé. Fonction pure.
 */
export function isAllowedPhiRecipientStrict(
  email: string,
  allowedDomains: readonly string[],
  isProduction: boolean
): boolean {
  // Garde de forme AVANT tout contrôle de domaine (cf. audit C1) : une liste
  // séparée par virgule/point-virgule, une forme d'affichage avec chevrons ou
  // une adresse à double "@" est refusée d'emblée, quel que soit le domaine
  // qu'on y trouverait en cherchant le dernier "@" — sans quoi
  // `"attacker@evil.com, dossier@suva.ch"` passerait ce contrôle ET partirait
  // vers les DEUX adresses via `nodemailer` (`to` accepte une liste CSV).
  if (!estAdresseUnique(email)) return false;
  if (isProduction && allowedDomains.length === 0) return false;
  return isAllowedRecipient(email, allowedDomains);
}
