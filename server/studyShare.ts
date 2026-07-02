/** Construit le titre/message d'une notification de partage d'étude. PUR. */
export function buildShareNotification(
  senderName: string,
  note?: string
): { title: string; message: string } {
  const who = senderName.trim() || "un confrère";
  return {
    title: `Étude transmise par ${who}`,
    message: (note ?? "").slice(0, 1000),
  };
}
