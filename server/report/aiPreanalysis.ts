import { ENV } from "../_core/env";

export interface PreanalysisKeyImage {
  pngBase64: string;
  sliceIndex: number;
}

export interface PreanalysisResult {
  resultats: string;
  conclusion: string;
  model: string;
}

const SYSTEM_PROMPT = [
  "Tu es un assistant de pré-analyse d'imagerie médicale destiné à un MÉDECIN (pas au patient).",
  "Tu observes une ou plusieurs coupes et tu proposes un BROUILLON en français, à valider par le médecin.",
  "Règles STRICTES :",
  "- N'invente AUCUNE mesure, valeur chiffrée, ni diagnostic catégorique.",
  '- Exprime explicitement l\'incertitude ("aspect évocateur de", "à corréler", "sous réserve").',
  "- Ne tente pas d'identifier le patient.",
  "- Réponds UNIQUEMENT avec deux sections, exactement dans ce format :",
  "Résultats:",
  "<description des observations>",
  "",
  "Conclusion:",
  "<synthèse prudente>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: { indication?: string }
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
  const userText = opts.indication
    ? `Indication clinique : ${opts.indication}\nDécris tes observations puis conclus.`
    : "Décris tes observations puis conclus.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let content = "";
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "30s",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: userText,
            images: keyImages.map(k => k.pngBase64),
          },
        ],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    content = data?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
  return { ...parseSections(content), model };
}

export function parseSections(text: string): {
  resultats: string;
  conclusion: string;
} {
  const m = text.match(
    /Résultats\s*:?\s*([\s\S]*?)\n\s*Conclusion\s*:?\s*([\s\S]*)$/i
  );
  if (m) return { resultats: m[1].trim(), conclusion: m[2].trim() };
  return { resultats: text.trim(), conclusion: "" };
}
