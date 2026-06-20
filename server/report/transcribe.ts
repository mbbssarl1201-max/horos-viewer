import { ENV } from "../_core/env";

/**
 * Transcription vocale via le service Whisper auto-hébergé (GPU suisse) — PHI-safe.
 * Reçoit l'audio (base64) du client, le relaie au service, renvoie le texte.
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  lang = "fr"
): Promise<{ text: string }> {
  if (!ENV.whisperUrl) throw new Error("Dictée non configurée");
  const bytes = Buffer.from(audioBase64, "base64");
  const ext = mimeType.includes("wav")
    ? "wav"
    : mimeType.includes("mp4") || mimeType.includes("mpeg")
      ? "mp4"
      : "webm";
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    `audio.${ext}`
  );
  const resp = await fetch(
    `${ENV.whisperUrl}/transcribe?lang=${encodeURIComponent(lang)}`,
    {
      method: "POST",
      headers: { "X-Whisper-Token": ENV.whisperToken },
      body: fd,
      signal: AbortSignal.timeout(180_000),
    }
  );
  if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}`);
  const d = (await resp.json()) as { text?: string };
  return { text: d.text ?? "" };
}
