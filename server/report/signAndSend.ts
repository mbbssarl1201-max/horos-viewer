/** Garde dure : un CR ne part QUE s'il est signé ET qu'on a un e-mail. */
export function assertSendable(status: string, email: string | null): void {
  if (status !== "signed") {
    throw new Error("Envoi refusé : le compte-rendu doit être signé.");
  }
  if (!email) {
    throw new Error("Envoi refusé : e-mail du référent requis.");
  }
}
