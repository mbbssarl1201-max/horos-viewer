// Validation pure du formulaire « changer mon mot de passe » — extraite du
// composant pour être testable sans DOM. Doit rester alignée sur le zod
// serveur (auth.changePassword : min 12, max 128, différent de l'actuel).

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

/** Retourne le message d'erreur à afficher, ou null si le formulaire est valide. */
export function validatePasswordChange(
  input: PasswordChangeInput
): string | null {
  if (!input.currentPassword) {
    return "Saisis ton mot de passe actuel.";
  }
  if (input.newPassword.length < PASSWORD_MIN_LENGTH) {
    return `Le nouveau mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`;
  }
  if (input.newPassword.length > PASSWORD_MAX_LENGTH) {
    return `Le nouveau mot de passe ne peut pas dépasser ${PASSWORD_MAX_LENGTH} caractères.`;
  }
  if (input.newPassword === input.currentPassword) {
    return "Le nouveau mot de passe doit être différent de l'actuel.";
  }
  if (input.newPassword !== input.confirmPassword) {
    return "La confirmation ne correspond pas au nouveau mot de passe.";
  }
  return null;
}
