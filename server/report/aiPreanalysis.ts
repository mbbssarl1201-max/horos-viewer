import { TRPCError } from "@trpc/server";
import { PNG } from "pngjs";
import { ENV } from "../_core/env";
import { getStudyById, countRecentAccess, recordAccess } from "../db";

/**
 * Réduit une image PNG (base64) à `maxDim` px sur son plus grand côté, par
 * sous-échantillonnage au plus proche voisin (pur JS, pas de dépendance native).
 * Indispensable AVANT l'envoi au VLM : sur CPU, une grande image vision coûte
 * des milliers de tokens et plusieurs minutes d'encodage. En cas d'échec de
 * décodage, renvoie l'image d'origine (best-effort).
 */
export function downscalePngBase64(b64: string, maxDim: number): string {
  try {
    const src = PNG.sync.read(Buffer.from(b64, "base64"));
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    if (scale >= 1) return b64;
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const dst = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      const sy = Math.min(src.height - 1, Math.floor(y / scale));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(src.width - 1, Math.floor(x / scale));
        const si = (sy * src.width + sx) * 4;
        const di = (y * w + x) * 4;
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
    return PNG.sync.write(dst).toString("base64");
  } catch {
    return b64;
  }
}

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
  "Tu es un assistant de pré-analyse d'imagerie médicale qui aide UN MÉDECIN à rédiger un compte rendu radiologique. Tu produis un BROUILLON en français, destiné à être relu, corrigé et SIGNÉ par le médecin.",
  "",
  "Méthode :",
  "- Tu n'observes que QUELQUES coupes sélectionnées, PAS l'examen complet : raisonne uniquement sur ce qui est RÉELLEMENT visible et ne suppose rien sur le reste de l'examen.",
  "- Tiens compte de la modalité et de la région indiquées ; décris de façon SYSTÉMATIQUE et structurée (structures osseuses, articulations/espaces, parties molles, et tout signe pertinent).",
  "- Reste DESCRIPTIF : ne nomme une pathologie précise (fracture, tumeur, lésion, etc.) QUE si le signe est franc et clairement visible ; sinon décris l'anomalie et formule une hypothèse PRUDENTE.",
  "- Si rien d'anormal n'est clairement visible, dis-le explicitement (\"pas d'anomalie manifeste sur les coupes fournies\").",
  '- N\'invente AUCUNE mesure ni valeur chiffrée. Exprime toujours l\'incertitude ("aspect évocateur de", "à corréler à la clinique", "sous réserve des coupes non fournies").',
  "- N'identifie jamais le patient et n'invente aucun contexte clinique.",
  "",
  "Réponds UNIQUEMENT avec ces deux sections, exactement dans ce format (rien d'autre) :",
  "Résultats:",
  "<description structurée de ce qui est visible>",
  "",
  "Conclusion:",
  "<synthèse prudente, hypothèses à confirmer>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: { indication?: string; modality?: string; studyDescription?: string }
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;

  // Un VLM ne traite que quelques images, et chaque image vision coûte ~4000
  // tokens de contexte : le défaut Ollama (num_ctx=4096) est dépassé dès UNE
  // image (sinon "request exceeds context size" + crash du runner). On plafonne
  // donc à 3 images et on dimensionne num_ctx en conséquence (borné à 16384).
  const images = keyImages
    .slice(0, 3)
    .map(k => downscalePngBase64(k.pngBase64, 512));
  const numCtx = Math.min(16384, 4096 + 4500 * Math.max(1, images.length));

  // Contexte de l'étude injecté pour ancrer le modèle (sinon il sur-interprète
  // une image sans savoir la modalité ni la région).
  const ctxLines: string[] = [];
  if (opts.modality) ctxLines.push(`Modalité : ${opts.modality}`);
  if (opts.studyDescription) ctxLines.push(`Examen : ${opts.studyDescription}`);
  if (opts.indication)
    ctxLines.push(`Indication clinique : ${opts.indication}`);
  ctxLines.push(
    `${images.length} coupe(s) clé(s) sélectionnée(s) te sont fournies ; l'examen complet n'est PAS joint.`
  );
  ctxLines.push(
    "Analyse uniquement ces coupes selon la méthode, puis rédige les sections Résultats et Conclusion."
  );
  const userText = ctxLines.join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
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
        options: { num_ctx: numCtx },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: userText,
            images,
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

// Indirection pour permettre au test de mocker l'appel réseau.
export const _internal = { generatePreanalysis };

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

export interface RunAiPreanalysisInput {
  studyId: number;
  keyImages: PreanalysisKeyImage[];
  indication?: string;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<PreanalysisResult> {
  const recent = await countRecentAccess(
    ctx.user.id,
    "study.ai.preanalysis",
    60
  );
  if (recent >= 30) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite de pré-analyses atteinte, réessayez plus tard.",
    });
  }
  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  const result = await _internal.generatePreanalysis(input.keyImages, {
    indication: input.indication,
    modality: (study as any).modality ?? undefined,
    studyDescription: (study as any).studyDescription ?? undefined,
  });

  await recordAccess({
    userId: ctx.user.id,
    action: "study.ai.preanalysis",
    studyId: study.id,
    detail: result.model,
    ipAddress: ctx.req?.ip ?? null,
  });
  return result;
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
