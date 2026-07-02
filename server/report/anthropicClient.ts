import type Anthropic from "@anthropic-ai/sdk";
import { isFableModel, REFUSAL_FALLBACK_MODEL } from "./anthropicModel";

/**
 * COUCHE D'APPEL ANTHROPIC — résilience aux REFUS classifieurs de Fable 5.
 *
 * POURQUOI : la famille Fable/Mythos fait tourner des classifieurs de sûreté qui
 * peuvent DÉCLINER une requête — réponse HTTP 200 avec `stop_reason:"refusal"` et
 * un contenu VIDE. Des faux positifs sur du contenu clinique / sciences du vivant
 * bénin sont documentés. Pour un compte rendu médical, un refus silencieux = perte
 * pure de l'analyse. On rejoue alors la MÊME requête sur Opus 4.8 (même surface
 * API, pas de classifieur bloquant), une seule fois.
 *
 * Repli CÔTÉ CLIENT (et non le paramètre serveur `fallbacks`) : compatible avec
 * toutes les versions du SDK. Un SDK plus récent permettrait le repli serveur en
 * un seul aller-retour (`betas:["server-side-fallback-2026-06-01"]` +
 * `fallbacks:[{model:"claude-opus-4-8"}]`) — à envisager après montée de version.
 *
 * ⚠️ CONFORMITÉ : Fable 5 exige 30 j de rétention (pas de ZDR). L'envoi de PHI
 * reste sous la garde `MEDIVIEW_CLOUD_AI_PHI_CONSENT` (DPA nLPD). Ce repli ne
 * l'affaiblit pas : il ne s'active que si un appel DÉJÀ autorisé a été décliné.
 */

export { isFableModel, REFUSAL_FALLBACK_MODEL } from "./anthropicModel";

/** Appel SDK avec repli sur refus (Fable → Opus 4.8). */
export async function anthropicCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts?: { timeout?: number }
): Promise<Anthropic.Message> {
  const resp = await client.messages.create(params, opts);
  if (resp.stop_reason === "refusal" && isFableModel(params.model)) {
    return client.messages.create(
      { ...params, model: REFUSAL_FALLBACK_MODEL },
      opts
    );
  }
  return resp;
}

/**
 * Appel `fetch` brut vers /v1/messages avec repli sur refus. Renvoie le JSON
 * parsé, ou `null` si l'appel HTTP échoue (le refus, lui, est un 200 : on le
 * détecte via `stop_reason` et on rejoue sur Opus 4.8).
 */
export async function anthropicMessagesFetch(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  apiKey: string
): Promise<Record<string, unknown> | null> {
  const call = (b: Record<string, unknown>) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal,
      body: JSON.stringify(b),
    });

  let resp = await call(body);
  if (!resp.ok) return null;
  let data = (await resp.json()) as Record<string, unknown>;

  if (data?.stop_reason === "refusal" && isFableModel(String(body.model))) {
    resp = await call({ ...body, model: REFUSAL_FALLBACK_MODEL });
    if (!resp.ok) return null;
    data = (await resp.json()) as Record<string, unknown>;
  }
  return data;
}
