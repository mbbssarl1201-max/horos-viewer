import { ENV } from "../_core/env";

/** Similarité cosinus. Dimensions différentes / vide → 0 (garde-fou). PUR. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[]
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embedding LOCAL via Ollama (/api/embeddings, modèle `OLLAMA_EMBED_MODEL`,
 * défaut `nomic-embed-text`). PHI-safe. Timeout 60 s.
 */
export async function embedText(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: ENV.ollamaEmbedModel, prompt: text }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(
        `Ollama embeddings HTTP ${resp.status}: ${t.slice(0, 200)}`
      );
    }
    const data = await resp.json();
    const emb = data?.embedding;
    if (!Array.isArray(emb) || emb.length === 0) {
      throw new Error(
        "Embeddings indisponibles — vérifiez `ollama pull nomic-embed-text` sur ollama-hermes."
      );
    }
    return emb as number[];
  } finally {
    clearTimeout(timeout);
  }
}
