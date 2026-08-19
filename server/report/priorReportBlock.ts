/**
 * Bloc TEXTE du CR antérieur injecté dans la comparaison d'antériorité.
 *
 * Le comparatif d'antériorité échantillonne les IMAGES antérieures ; cette
 * fonction y ajoute le TEXTE du compte-rendu précédent pour ancrer l'évolution
 * sur ce qui avait réellement été écrit et signalé.
 *
 * GARDE-FOU MÉDICAL : seuls les CR **signés** (validés par le médecin) sont
 * repris. Un brouillon (`draft`, potentiellement généré par l'IA) n'est JAMAIS
 * réinjecté — sinon l'IA se comparerait à une conclusion non validée d'elle-même.
 * Fonction pure (testable), sans I/O : l'appelant fournit les lignes de CR.
 */
export interface PriorReportRow {
  date?: string | null;
  status: string;
  conclusion?: string | null;
}

export function buildPriorReportBlock(
  reports: PriorReportRow[]
): string | undefined {
  const usable = reports.filter(
    r => r.status === "signed" && (r.conclusion?.trim().length ?? 0) > 0
  );
  if (usable.length === 0) return undefined;

  const lines = usable.map(r => {
    const date = r.date?.trim() ? r.date.trim() : "date inconnue";
    return `- CR ANTÉRIEUR SIGNÉ du ${date} : ${r.conclusion!.trim()}`;
  });

  return [
    "TEXTE DU (DES) CR SIGNÉ(S) ANTÉRIEUR(S) — DONNÉES factuelles déjà validées " +
      "par le médecin. Appuie l'évolution sur ce texte et signale toute discordance " +
      "entre l'image actuelle et ce qui y était décrit. N'invente rien au-delà.",
    ...lines,
  ].join("\n");
}
