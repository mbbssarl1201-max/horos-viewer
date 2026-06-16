import { ENV } from "../_core/env";

/**
 * Parse une ligne NDJSON du flux Ollama /api/chat. Renvoie le delta de contenu,
 * ou null (ligne vide, done, contenu vide, JSON invalide). PUR — ne jette jamais.
 */
export function parseOllamaStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    const content = obj?.message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    return null;
  } catch {
    return null;
  }
}

type ChatMsg = { role: string; content: string };

/**
 * Appelle Ollama /api/chat en streaming. Pour chaque token, appelle onToken.
 * Renvoie le texte complet accumulé. Timeout 120 s, AbortController.
 */
export async function streamOllamaChat(
  messages: ChatMsg[],
  onToken: (delta: string) => void,
  externalSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  // Si le client se déconnecte, on avorte le flux Ollama (pas de CPU gaspillé).
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }
  let full = "";
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaTextModel,
        stream: true,
        keep_alive: "30s",
        messages,
      }),
    });
    if (!resp.ok || !resp.body) {
      const txt = resp.ok ? "" : await resp.text().catch(() => "");
      throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseOllamaStreamLine(line);
        if (delta) {
          full += delta;
          onToken(delta);
        }
      }
    }
    const tail = parseOllamaStreamLine(buffer);
    if (tail) {
      full += tail;
      onToken(tail);
    }
    return full;
  } finally {
    clearTimeout(timeout);
    if (externalSignal)
      externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
