import { ENV } from "../_core/env";
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
