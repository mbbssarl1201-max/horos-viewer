export interface Correction {
  modality: string;
  draft: string;
  signed: string;
}

/** Regroupe par modalité, ne garde que celles atteignant le seuil. */
export function groupByModality(
  items: Correction[],
  minSamples: number
): Map<string, Correction[]> {
  const map = new Map<string, Correction[]>();
  for (const it of items) {
    const k = (it.modality || "?").toUpperCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  Array.from(map.keys()).forEach(k => {
    if (map.get(k)!.length < minSamples) map.delete(k);
  });
  return map;
}

/** Filet anti-PHI : retire noms en MAJUSCULES, dates, identifiants numériques longs. */
export function stripPhiLike(text: string): string {
  return (text ?? "")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, "[date]")
    .replace(/\b\d{6,}\b/g, "[id]")
    .replace(/\b[A-ZÀ-Þ]{2,}(?:\s+[A-ZÀ-Þ]{2,}){1,5}\b/g, "[nom]")
    .trim();
}
