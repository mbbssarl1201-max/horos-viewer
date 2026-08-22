import { ENV } from "../_core/env";

/**
 * Client vision Gemini (Vertex UE) — utilisé par le dépistage exhaustif et la
 * double lecture. Même endpoint/auth que le chat Hermès (hermesChat), mais SANS
 * la condition `chatBackend === "vertex"` : la lecture radio peut passer par
 * Gemini même quand le chat tourne sur Claude ou en local.
 *
 * Données patient → toujours gardé par le consentement PHI (cloudAiPhiConsent),
 * données traitées en Europe (location Vertex UE).
 */

/** Gemini vision utilisable ? (config Vertex + consentement PHI). */
export function geminiVisionConfigured(): boolean {
  return (
    !!ENV.geminiVertexProject &&
    !!ENV.geminiVertexToken &&
    ENV.cloudAiPhiConsent
  );
}

/**
 * Extrait le texte d'une réponse `generateContent` (parts textuelles
 * concaténées). Null si la structure est absente ou vide. PURE.
 */
export function extractGeminiText(json: unknown): string | null {
  const parts = (json as any)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const txt = parts
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("");
  return txt.length > 0 ? txt : null;
}

/**
 * Appel vision Gemini : un texte + des images PNG (base64), température 0.
 * Best-effort : null sur toute erreur (réseau, HTTP, parse) — jamais de throw,
 * l'appelant a toujours un repli (modèle local).
 */
export async function geminiVision(opts: {
  model: string;
  system: string;
  userText: string;
  pngBase64: string[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!geminiVisionConfigured()) return null;
  const loc = ENV.geminiVertexLocation;
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${ENV.geminiVertexProject}/locations/${loc}/publishers/google/models/${opts.model}:generateContent`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.geminiVertexToken}`,
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: opts.userText },
              ...opts.pngBase64.map(data => ({
                inlineData: { mimeType: "image/png", data },
              })),
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? 1024,
          temperature: 0,
        },
      }),
    });
    if (!resp.ok) return null;
    return extractGeminiText(await resp.json());
  } catch {
    return null;
  }
}
