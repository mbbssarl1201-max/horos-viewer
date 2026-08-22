import { createSign } from "crypto";
import { existsSync, readFileSync } from "fs";
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

/**
 * Gemini vision utilisable ? Config Vertex (token statique OU service account
 * JSON monté, comme medicentral) + consentement PHI.
 */
export function geminiVisionConfigured(): boolean {
  return (
    !!ENV.geminiVertexProject &&
    (!!ENV.geminiVertexToken ||
      (!!ENV.geminiVertexSaPath && existsSync(ENV.geminiVertexSaPath))) &&
    ENV.cloudAiPhiConsent
  );
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * JWT RS256 d'échange OAuth pour un service account Google (scope
 * cloud-platform, validité 1 h). Déterministe pour un instant donné. PURE
 * (hors signature, déterministe elle aussi pour une clé donnée).
 */
export function createSignedJwt(sa: ServiceAccount, nowS: number): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    iat: nowS,
    exp: nowS + 3600,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(sa.private_key)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

// Cache du jeton d'accès Vertex (renouvelé 5 min avant expiration).
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Jeton d'accès Vertex : `GEMINI_VERTEX_TOKEN` statique si fourni, sinon
 * échange OAuth du service account (fichier JSON monté). Null si indisponible.
 */
async function getVertexAccessToken(): Promise<string | null> {
  if (ENV.geminiVertexToken) return ENV.geminiVertexToken;
  if (cachedToken && Date.now() < cachedToken.expiresAtMs)
    return cachedToken.token;
  try {
    const sa = JSON.parse(
      readFileSync(ENV.geminiVertexSaPath, "utf8")
    ) as ServiceAccount;
    const jwt = createSignedJwt(sa, Math.floor(Date.now() / 1000));
    const resp = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    cachedToken = {
      token: data.access_token,
      expiresAtMs: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
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
  const token = await getVertexAccessToken();
  if (!token) return null;
  const loc = ENV.geminiVertexLocation;
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${ENV.geminiVertexProject}/locations/${loc}/publishers/google/models/${opts.model}:generateContent`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
