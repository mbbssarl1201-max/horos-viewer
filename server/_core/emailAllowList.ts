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
  if (isProduction && allowedDomains.length === 0) return false;
  return isAllowedRecipient(email, allowedDomains);
}
