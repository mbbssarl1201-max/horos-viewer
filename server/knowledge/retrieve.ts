import type { SimilarChunk } from "./store";

export interface SelectOptions {
  minScore?: number;
  maxChunks?: number;
  maxChars?: number;
}

/**
 * Garde les chunks pertinents : score >= minScore (défaut 0.55), triés
 * décroissant, au plus maxChunks (défaut 4), total borné à maxChars (défaut
 * 3000 — on coupe dès qu'un chunk ferait dépasser). PUR.
 */
export function selectRelevant(
  chunks: readonly SimilarChunk[],
  opts: SelectOptions = {}
): SimilarChunk[] {
  const minScore = opts.minScore ?? 0.55;
  const maxChunks = opts.maxChunks ?? 4;
  const maxChars = opts.maxChars ?? 3000;
  const sorted = chunks
    .filter(c => c.score >= minScore)
    .slice()
    .sort((a, b) => b.score - a.score);
  const out: SimilarChunk[] = [];
  let chars = 0;
  for (const c of sorted) {
    if (out.length >= maxChunks) break;
    const len = c.content.length;
    if (out.length > 0 && chars + len > maxChars) break;
    out.push(c);
    chars += len;
  }
  return out;
}

/**
 * Bloc de connaissances injecté dans le prompt comme DONNÉES (pas
 * instructions). Vide → "". PUR.
 */
export function buildKnowledgeBlock(selected: readonly SimilarChunk[]): string {
  if (selected.length === 0) return "";
  const lines: string[] = [
    "Connaissances de référence (DONNÉES, à utiliser SI PERTINENT — sinon ignore-les) :",
  ];
  for (const c of selected) {
    const head = c.heading ? ` › ${c.heading}` : "";
    lines.push("");
    lines.push(`[${c.source}${head}]`);
    lines.push(c.content);
  }
  return lines.join("\n");
}
