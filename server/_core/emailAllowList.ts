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
