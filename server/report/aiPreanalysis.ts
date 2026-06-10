import { TRPCError } from "@trpc/server";
import { PNG } from "pngjs";
import { ENV } from "../_core/env";
import {
  getStudyById,
  listSeriesByStudy,
  countRecentAccess,
  recordAccess,
} from "../db";

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
  technique: string;
  resultats: string;
  conclusion: string;
  model: string;
  // Coupe (numéro d'instance) désignée par l'IA comme montrant le mieux
  // l'anomalie, ou null si aucune anomalie / non fourni.
  keySliceNumber?: number | null;
  // L'IA a-t-elle repéré une anomalie ? (null si non précisé)
  abnormal?: boolean | null;
}

const SYSTEM_PROMPT = [
  "Tu es un assistant de pré-analyse d'imagerie médicale qui aide UN MÉDECIN à rédiger un compte rendu radiologique. Tu produis un BROUILLON en français, destiné à être relu, corrigé et SIGNÉ par le médecin.",
  "",
  "Méthode :",
  "- On te fournit un ÉCHANTILLON de coupes RÉPARTIES SUR TOUT LE VOLUME (numérotées), pour te donner une vue d'ensemble de l'examen. Raisonne sur l'ensemble de ces coupes ; tu ne vois pas chaque coupe, donc reste prudent sur ce qui pourrait se trouver entre deux coupes fournies.",
  "- Parcours les coupes une à une ; si tu repères une anomalie (ex. fracture, lésion, asymétrie), IDENTIFIE le NUMÉRO de la coupe fournie qui la montre le mieux.",
  "- Tiens compte de la modalité et de la région indiquées ; décris de façon SYSTÉMATIQUE et structurée (structures osseuses, articulations/espaces, parties molles, et tout signe pertinent).",
  "- Reste DESCRIPTIF : ne nomme une pathologie précise (fracture, tumeur, lésion, etc.) QUE si le signe est franc et clairement visible ; sinon décris l'anomalie et formule une hypothèse PRUDENTE.",
  "- ATTENTION (CT, fenêtre osseuse) : l'os cortical dense apparaît NORMALEMENT blanc/très brillant — c'est l'anatomie NORMALE. Ne l'interprète JAMAIS comme une tumeur, une masse, une lésion, une calcification suspecte ou un objet métallique. N'évoque « tumeur / masse / corps étranger / objet métallique » QUE devant une lésion franchement pathologique (destruction osseuse nette, masse de parties molles évidente). En cas de doute, considère que c'est NORMAL.",
  "- Par défaut, privilégie une description NORMALE et rassurante ; ne sur-interprète pas. Mieux vaut « pas d'anomalie manifeste » qu'une fausse alerte.",
  "- Si rien d'anormal n'est clairement visible, dis-le explicitement (\"pas d'anomalie osseuse manifeste sur les coupes fournies\").",
  '- N\'invente AUCUNE mesure ni valeur chiffrée. Exprime toujours l\'incertitude ("aspect évocateur de", "à corréler à la clinique", "sous réserve des coupes non fournies").',
  "- Si des ANTÉCÉDENTS médicaux du patient sont fournis, relie EXPLICITEMENT tes observations et ta conclusion à ces antécédents (évolution par rapport à une pathologie connue, recherche de complication ou de récidive, cohérence avec l'histoire clinique) — sans inventer d'antécédent non fourni.",
  "- N'identifie jamais le patient et n'invente aucun contexte clinique.",
  "",
  "Réponds UNIQUEMENT avec ces sections, exactement dans ce format (rien d'autre) :",
  "Technique:",
  "<description FACTUELLE et brève de l'acquisition d'après la modalité (ex. « Acquisition tomodensitométrique, coupes axiales »). N'invente NI produit de contraste, NI paramètres (kV/mAs/épaisseur) s'ils ne sont pas fournis.>",
  "",
  "Résultats:",
  "<description structurée de ce qui est visible sur l'ensemble des coupes>",
  "",
  "Conclusion:",
  "<synthèse prudente, hypothèses à confirmer>",
  "",
  "Anomalie:",
  "<oui ou non — y a-t-il une anomalie clairement visible ?>",
  "",
  "Coupe-clé:",
  "<le NUMÉRO de la coupe fournie qui montre le mieux l'anomalie ; ou « aucune » s'il n'y a pas d'anomalie>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: {
    indication?: string;
    modality?: string;
    studyDescription?: string;
    antecedents?: string;
    totalSlices?: number;
  }
): Promise<PreanalysisResult> {
  const useClaude = ENV.aiBackend === "claude" && ENV.anthropicApiKey;
  // Claude encaisse plus d'images (analyse de tout le volume échantillonné) ;
  // Ollama local est plafonné plus bas (RAM/latence). Les images sont réduites
  // avant l'envoi (sur CPU, une image vision coûte des milliers de tokens).
  const maxImages = useClaude ? 16 : 6;
  const chosen = keyImages.slice(0, maxImages);
  const images = chosen.map(k => downscalePngBase64(k.pngBase64, 768));
  // Numéro de coupe associé à CHAQUE image (dans l'ordre), pour que l'IA puisse
  // désigner la coupe-clé par son numéro.
  const sliceNumbers = chosen.map(k => k.sliceIndex);
  const numCtx = Math.min(16384, 4096 + 4500 * Math.max(1, images.length));

  // Contexte de l'étude injecté pour ancrer le modèle (sinon il sur-interprète
  // une image sans savoir la modalité ni la région).
  const ctxLines: string[] = [];
  if (opts.modality) ctxLines.push(`Modalité : ${opts.modality}`);
  if (opts.studyDescription) ctxLines.push(`Examen : ${opts.studyDescription}`);
  if (opts.indication)
    ctxLines.push(`Indication clinique : ${opts.indication}`);
  if (opts.antecedents)
    ctxLines.push(`Antécédents médicaux du patient : ${opts.antecedents}`);
  const total = opts.totalSlices ?? images.length;
  ctxLines.push(
    `Échantillon de ${images.length} coupe(s) réparties sur les ${total} coupes du volume. Dans l'ordre, ces images correspondent aux coupes n° : ${sliceNumbers.join(", ")}.`
  );
  ctxLines.push(
    "Analyse l'ensemble de ces coupes selon la méthode, rédige Technique / Résultats / Conclusion, puis indique Anomalie (oui/non) et le numéro de la Coupe-clé."
  );
  const userText = ctxLines.join("\n");

  // Aiguillage du backend : Claude (cloud, meilleure qualité d'analyse) si
  // configuré et clé présente, sinon Ollama local (PHI-safe).
  if (useClaude) {
    return generateViaClaude(images, userText, sliceNumbers);
  }
  return generateViaOllama(images, userText, numCtx);
}

async function generateViaOllama(
  images: string[],
  userText: string,
  numCtx: number
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
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
  return {
    ...parseSections(content),
    ...parseKeySlice(content),
    model: ENV.ollamaVisionModel,
  };
}

async function generateViaClaude(
  images: string[],
  userText: string,
  sliceNumbers: number[]
): Promise<PreanalysisResult> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  // On étiquette CHAQUE image avec son numéro de coupe (bloc texte juste avant
  // l'image) pour que le modèle puisse désigner la coupe-clé sans ambiguïté.
  const content: any[] = [];
  images.forEach((b64, i) => {
    content.push({
      type: "text",
      text: `Coupe n° ${sliceNumbers[i] ?? i + 1} :`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: b64 },
    });
  });
  content.push({ type: "text", text: userText });
  const resp = await client.messages.create({
    model: ENV.anthropicModel,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  const text = (resp.content as any[])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
  return {
    ...parseSections(text),
    ...parseKeySlice(text),
    model: ENV.anthropicModel,
  };
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
  antecedents?: string;
  // Échantillonnage serveur du volume (analyse de TOUTE la série) :
  seriesId?: number;
  windowCenter?: number;
  windowWidth?: number;
  sampleCount?: number;
}

export interface RunAiPreanalysisResult extends PreanalysisResult {
  // Image de la coupe désignée par l'IA, rendue côté serveur, à retenir comme
  // image clé du compte rendu (null si pas d'anomalie / rendu impossible).
  keyImage?: { pngBase64: string; sliceIndex: number } | null;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<RunAiPreanalysisResult> {
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

  // Anti-IDOR : la série demandée DOIT appartenir à l'étude (sinon un client
  // pourrait faire rendre/exfiltrer les coupes d'une série arbitraire — PHI).
  // Même garde que l'envoi de compte rendu.
  if (input.seriesId) {
    const series = await listSeriesByStudy(input.studyId);
    if (!series.some((s: any) => s.id === input.seriesId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Série inconnue pour cette étude",
      });
    }
  }

  const wc = input.windowCenter ?? 40;
  const ww = input.windowWidth ?? 400;

  // Analyse de TOUT le volume : le serveur échantillonne des coupes réparties
  // sur la série (dans la fenêtre W/L du médecin → fractures visibles). Repli
  // sur les images clés capturées côté client si l'échantillonnage échoue.
  let images: PreanalysisKeyImage[] = [];
  let totalSlices = 0;
  if (input.seriesId) {
    try {
      const { sampleSeriesPngs } = await import("./aiSampling");
      const sampled = await sampleSeriesPngs(input.seriesId, {
        windowCenter: wc,
        windowWidth: ww,
        count: input.sampleCount ?? 16,
      });
      images = sampled.images.map(s => ({
        pngBase64: s.pngBase64,
        sliceIndex: s.sliceNumber,
      }));
      totalSlices = sampled.totalSlices;
    } catch (e) {
      console.warn("[aiPreanalysis] échantillonnage série échoué:", e);
    }
  }
  if (images.length === 0) {
    input.keyImages.forEach(k => assertPng(k.pngBase64));
    images = input.keyImages;
    totalSlices = images.length;
  }

  const result = await _internal.generatePreanalysis(images, {
    indication: input.indication,
    antecedents: input.antecedents,
    modality: (study as any).modality ?? undefined,
    studyDescription: (study as any).studyDescription ?? undefined,
    totalSlices,
  });

  // Rendu de la coupe désignée par l'IA → image clé du compte rendu.
  let keyImage: RunAiPreanalysisResult["keyImage"] = null;
  if (input.seriesId && result.keySliceNumber) {
    try {
      const { renderSliceByNumber } = await import("./aiSampling");
      const b64 = await renderSliceByNumber(
        input.seriesId,
        result.keySliceNumber,
        { windowCenter: wc, windowWidth: ww }
      );
      if (b64) keyImage = { pngBase64: b64, sliceIndex: result.keySliceNumber };
    } catch (e) {
      console.warn("[aiPreanalysis] rendu coupe-clé échoué:", e);
    }
  }

  await recordAccess({
    userId: ctx.user.id,
    action: "study.ai.preanalysis",
    studyId: study.id,
    detail: result.model,
    ipAddress: ctx.req?.ip ?? null,
  });
  return { ...result, keyImage };
}

// Extrait l'anomalie (oui/non) et le numéro de coupe-clé renvoyés par l'IA.
export function parseKeySlice(text: string): {
  abnormal: boolean | null;
  keySliceNumber: number | null;
} {
  const abn = text.match(/Anomalie\s*:?\s*(oui|non|yes|no)/i);
  const ks = text.match(/Coupe[-\s]?cl[ée]\s*:?\s*(\d+|aucune|none|aucun)/i);
  return {
    abnormal: abn ? /oui|yes/i.test(abn[1]) : null,
    keySliceNumber: ks && /^\d+$/.test(ks[1]) ? parseInt(ks[1], 10) : null,
  };
}

export function parseSections(text: string): {
  technique: string;
  resultats: string;
  conclusion: string;
} {
  // On retire d'abord les lignes méta finales (Anomalie / Coupe-clé) pour
  // qu'elles ne soient pas absorbées dans la Conclusion.
  const cut = text.search(/\n\s*(Anomalie|Coupe[-\s]?cl[ée])\s*:/i);
  if (cut >= 0) text = text.slice(0, cut);
  // Format attendu : Technique / Résultats / Conclusion.
  const m3 = text.match(
    /Technique\s*:?\s*([\s\S]*?)\n\s*Résultats\s*:?\s*([\s\S]*?)\n\s*Conclusion\s*:?\s*([\s\S]*)$/i
  );
  if (m3)
    return {
      technique: m3[1].trim(),
      resultats: m3[2].trim(),
      conclusion: m3[3].trim(),
    };
  // Repli : ancien format à 2 sections (Résultats / Conclusion), technique vide.
  const m2 = text.match(
    /Résultats\s*:?\s*([\s\S]*?)\n\s*Conclusion\s*:?\s*([\s\S]*)$/i
  );
  if (m2)
    return { technique: "", resultats: m2[1].trim(), conclusion: m2[2].trim() };
  // Repli ultime : tout dans resultats.
  return { technique: "", resultats: text.trim(), conclusion: "" };
}
