import { ENV } from "../_core/env";

/**
 * Suggestion de codes diagnostiques (CIM-10) à partir d'un compte rendu, via le
 * LLM texte local (ollama-hermes, PHI-safe). SUGGESTION à valider — un LLM peut
 * se tromper de code ; la facturation réelle reste dans MediAdmin.
 */
export interface CodeSuggestion {
  code: string;
  label: string;
}

export async function suggestCodes(
  resultats: string,
  conclusion: string
): Promise<{ codes: CodeSuggestion[]; tardoc: CodeSuggestion[] }> {
  if (!ENV.ollamaUrl) return { codes: [], tardoc: [] };
  const sys =
    "Tu aides à coder un compte rendu de radiologie. Propose 1 à 5 codes diagnostiques " +
    "CIM-10 (ICD-10) PERTINENTS au compte rendu. Réponds UNIQUEMENT en JSON strict : " +
    '{"codes":[{"code":"R93.1","label":"..."}],"tardoc":[{"code":"39.0010","label":"..."}]}. Pas d\'autre texte. ' +
    "Si le compte rendu est normal, propose le code approprié (ex. examen normal). " +
    "Ce sont des SUGGESTIONS à valider par le médecin. " +
    "Propose AUSSI 1 à 5 actes TARDOC (tarif suisse) correspondant à l'examen. Ce sont des SUGGESTIONS à valider, ne facture rien.";
  const user = `Compte rendu :\nRésultats : ${resultats}\nConclusion : ${conclusion}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaTextModel,
        stream: false,
        format: "json",
        options: { temperature: 0.1, num_predict: 400 },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    const content = data?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const codes: CodeSuggestion[] = Array.isArray(parsed?.codes)
      ? parsed.codes
          .filter((c: any) => c && typeof c.code === "string")
          .slice(0, 5)
          .map((c: any) => ({
            code: String(c.code).slice(0, 12),
            label: String(c.label ?? "").slice(0, 200),
          }))
      : [];
    const tardoc: CodeSuggestion[] = Array.isArray(parsed?.tardoc)
      ? parsed.tardoc
          .filter((c: any) => c && typeof c.code === "string")
          .slice(0, 5)
          .map((c: any) => ({
            code: String(c.code).slice(0, 12),
            label: String(c.label ?? "").slice(0, 200),
          }))
      : [];
    return { codes, tardoc };
  } finally {
    clearTimeout(timeout);
  }
}
