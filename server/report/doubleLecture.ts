import { ENV } from "../_core/env";
import { anthropicMessagesFetch } from "./anthropicClient";
import { geminiVision, geminiVisionConfigured } from "./geminiVision";
import { downscalePngBase64, type PreanalysisKeyImage } from "./aiPreanalysis";

/**
 * Double lecture croisée : un DEUXIÈME radiologue-modèle (Gemini 2.5 Pro,
 * Vertex UE) relit les mêmes images clés SANS voir la première lecture, puis le
 * premier lecteur (Opus, via reconcileReads) compare les deux et liste les
 * désaccords comme points de vigilance. Analogie : double lecture humaine en
 * radiologie. Tout est fail-soft : sans Gemini, le CR sort comme avant.
 */

export interface SecondRead {
  resultats: string;
  conclusion: string;
  abnormal: boolean | null;
  model: string;
}

/** Nettoie une étiquette de section (gras markdown, espaces). */
function stripSection(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/^[\s:]+|[\s]+$/g, "")
    .trim();
}

/**
 * Découpe une réponse balisée `RESULTATS:` / `CONCLUSION:` / `ANORMAL: oui|non`
 * (casse et gras markdown tolérés, accents optionnels). Null si les sections
 * RESULTATS et CONCLUSION manquent. PURE.
 */
export function parseSecondRead(txt: string, model: string): SecondRead | null {
  const m = txt.match(
    /r[ée]sultats?\s*:?\**\s*\n?([\s\S]*?)\n\s*\**\s*conclusion\s*:?\**\s*\n?([\s\S]*?)(?:\n\s*\**\s*anormal\s*:?\**\s*(oui|non|yes|no)|$)/i
  );
  if (!m) return null;
  const resultats = stripSection(m[1]);
  const conclusion = stripSection(m[2]);
  if (!resultats || !conclusion) return null;
  const ab = m[3]?.toLowerCase();
  return {
    resultats,
    conclusion,
    abnormal: ab ? ab === "oui" || ab === "yes" : null,
    model,
  };
}

/**
 * Prompts de la relecture. Le second lecteur ne reçoit JAMAIS la première
 * lecture (indépendance — sinon il ancre dessus). PURE.
 */
export function buildSecondReadPrompt(opts: {
  indication?: string;
  modality?: string;
  measurements?: string;
  totalSlices?: number;
}): { system: string; user: string } {
  const system = [
    "Tu es un DEUXIÈME radiologue senior. Tu fais une lecture INDÉPENDANTE d'images sélectionnées d'un examen (tu ne connais PAS la première lecture).",
    "Passe en revue chaque structure de façon systématique, recherche activement les signes pathologiques, reste prudent (brouillon destiné à un médecin).",
    "Réponds STRICTEMENT au format suivant, sans autre texte :",
    "RESULTATS:",
    "<tes constatations, concises>",
    "CONCLUSION:",
    "<ta conclusion, 1-3 phrases>",
    "ANORMAL: oui|non",
  ].join("\n");
  const parts: string[] = [];
  if (opts.modality) parts.push(`Modalité : ${opts.modality}.`);
  if (opts.totalSlices)
    parts.push(
      `Images clés issues d'un dépistage sur ${opts.totalSlices} coupes.`
    );
  if (opts.indication) parts.push(`Indication clinique : ${opts.indication}`);
  if (opts.measurements)
    parts.push(`Mesures objectives (segmentation) : ${opts.measurements}`);
  parts.push("Lis les images et rends ta lecture au format demandé.");
  return { system, user: parts.join("\n") };
}

/**
 * Relecture indépendante par Gemini (modèle `geminiSecondReadModel`). ≤20
 * images, 1024 px. Null si non configuré ou échec — l'appelant garde son repli.
 */
export async function secondReadGemini(
  keyImages: PreanalysisKeyImage[],
  opts: Parameters<typeof buildSecondReadPrompt>[0]
): Promise<SecondRead | null> {
  if (!geminiVisionConfigured() || keyImages.length === 0) return null;
  const { system, user } = buildSecondReadPrompt(opts);
  const pics = keyImages
    .slice(0, 20)
    .map(k => downscalePngBase64(k.pngBase64, 1024));
  const txt = await geminiVision({
    model: ENV.geminiSecondReadModel,
    system,
    userText: user,
    pngBase64: pics,
    maxTokens: 1500,
    timeoutMs: 180_000,
  });
  if (!txt) return null;
  return parseSecondRead(txt, ENV.geminiSecondReadModel);
}

/**
 * Prompts de réconciliation : le premier lecteur (Opus) compare les deux
 * lectures et rend une synthèse courte + un verdict `ACCORD: oui|non`. PURE.
 */
export function buildReconcilePrompt(
  primary: { resultats: string; conclusion: string; model: string },
  second: SecondRead
): { system: string; user: string } {
  const system = [
    "Tu compares DEUX lectures indépendantes du même examen d'imagerie (double lecture radiologique).",
    "Rends, en français et de façon CONCISE :",
    "1. Les points d'accord (1-2 lignes).",
    "2. Les DÉSACCORDS, chacun sur une ligne commençant par « À VÉRIFIER PAR LE MÉDECIN : » (rien si aucun).",
    "Termine STRICTEMENT par une ligne « ACCORD: oui » si les conclusions concordent sur l'essentiel, sinon « ACCORD: non ».",
    "N'invente aucun finding : ne cite que ce que les lectures contiennent.",
  ].join("\n");
  const user = [
    `LECTURE 1 (${primary.model}) :`,
    `Résultats : ${primary.resultats}`,
    `Conclusion : ${primary.conclusion}`,
    "",
    `LECTURE 2 (${second.model}) :`,
    `Résultats : ${second.resultats}`,
    `Conclusion : ${second.conclusion}`,
  ].join("\n");
  return { system, user };
}

/**
 * Lit la synthèse de réconciliation : verdict sur la ligne `ACCORD:` (retirée
 * du texte affiché), `agree` null si absent. Null si texte vide. PURE.
 */
export function parseReconcile(
  txt: string
): { section: string; agree: boolean | null } | null {
  const trimmed = txt.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\s*\**\s*accord\s*:?\**\s*(oui|non|yes|no)\b.*$/im);
  const agree = m
    ? m[1].toLowerCase() === "oui" || m[1].toLowerCase() === "yes"
    : null;
  const section = trimmed
    .replace(/^\s*\**\s*accord\s*:?\**\s*(oui|non|yes|no)\b.*$/gim, "")
    .trim();
  if (!section) return null;
  return { section, agree };
}

/**
 * Réconciliation par le premier lecteur (Opus, texte seul). Fail-soft : null si
 * Claude non configuré / non consenti / échec API.
 */
export async function reconcileReads(
  primary: { resultats: string; conclusion: string; model: string },
  second: SecondRead
): Promise<{ section: string; agree: boolean | null } | null> {
  if (
    ENV.aiBackend !== "claude" ||
    !ENV.anthropicApiKey ||
    !ENV.cloudAiPhiConsent
  )
    return null;
  const { system, user } = buildReconcilePrompt(primary, second);
  try {
    const data = await anthropicMessagesFetch(
      {
        model: ENV.anthropicModel,
        max_tokens: 700,
        system,
        messages: [{ role: "user", content: user }],
      },
      AbortSignal.timeout(90_000),
      ENV.anthropicApiKey
    );
    const txt = (data as any)?.content?.find(
      (b: any) => b?.type === "text"
    )?.text;
    if (typeof txt !== "string") return null;
    return parseReconcile(txt);
  } catch {
    return null;
  }
}
