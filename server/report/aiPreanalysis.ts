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

// Côté le plus grand (px) auquel on réduit chaque coupe avant l'envoi au VLM.
// La vision tournant sur GPU (L4), on conserve la pleine résolution des coupes
// CT (512 px) ; 768 est un plafond qui n'altère pas les coupes natives.
const VISION_MAX_DIM = 768;

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
  // Verdict d'évolution comparative (mode antériorité) ; null hors comparaison.
  evolution?: "stable" | "progression" | "regression" | null;
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

const COMPARATIVE_ADDENDUM = [
  "",
  "COMPARAISON D'ANTÉRIORITÉ :",
  "On te fournit DEUX examens du MÊME patient : l'EXAMEN ACTUEL et un EXAMEN ANTÉRIEUR (daté). Chaque coupe fournie est étiquetée par l'examen auquel elle appartient.",
  "- Compare les deux examens et décris l'ÉVOLUTION (apparition, disparition, stabilité, augmentation ou diminution d'une anomalie). Reste prudent et purement visuel : n'invente AUCUNE mesure chiffrée.",
  "- Dans la section Résultats, ajoute un paragraphe commençant par « Comparaison à l'examen du <date> : … » résumant l'évolution.",
  "- APRÈS la ligne Coupe-clé, ajoute une DERNIÈRE ligne supplémentaire, exactement à ce format :",
  "Évolution:",
  "<stable | progression | régression — l'anomalie est-elle globalement stable, en progression (aggravation/augmentation) ou en régression (amélioration/diminution) ?>",
].join("\n");

export async function generatePreanalysis(
  keyImages: PreanalysisKeyImage[],
  opts: {
    indication?: string;
    modality?: string;
    studyDescription?: string;
    antecedents?: string;
    totalSlices?: number;
    prior?: {
      images: PreanalysisKeyImage[];
      date?: string;
      totalSlices?: number;
    };
  }
): Promise<PreanalysisResult> {
  const claudeConfigured = ENV.aiBackend === "claude" && !!ENV.anthropicApiKey;
  // Garde nLPD (audit H4) : pas d'envoi de pixels (PHI potentiellement brûlé)
  // vers Claude (cloud US) sans consentement documenté (DPA). Sinon → repli
  // Ollama local (PHI-safe), pour ne JAMAIS exfiltrer par défaut.
  const useClaude = claudeConfigured && ENV.cloudAiPhiConsent;
  if (claudeConfigured && !ENV.cloudAiPhiConsent) {
    console.warn(
      "[aiPreanalysis] AI_BACKEND=claude ignoré : MEDIVIEW_CLOUD_AI_PHI_CONSENT non activé (nLPD/DPA) → repli sur Ollama local."
    );
  }
  const comparing = !!opts.prior && opts.prior.images.length > 0;
  // Vision portée par le GPU L4 (24 Go VRAM) → 16 coupes pleine résolution,
  // comme Claude. En mode comparatif, le budget est partagé entre les deux examens.
  const maxImages = 16;
  const perStudy = comparing
    ? Math.max(1, Math.floor(maxImages / 2))
    : maxImages;

  const chosen = keyImages.slice(0, perStudy);
  const curImages = chosen.map(k =>
    downscalePngBase64(k.pngBase64, VISION_MAX_DIM)
  );
  const curSlices = chosen.map(k => k.sliceIndex);

  const priorChosen = comparing ? opts.prior!.images.slice(0, perStudy) : [];
  const priorImages = priorChosen.map(k =>
    downscalePngBase64(k.pngBase64, VISION_MAX_DIM)
  );
  const priorSlices = priorChosen.map(k => k.sliceIndex);
  const priorDate = opts.prior?.date;

  const images = [...curImages, ...priorImages];
  const numCtx = Math.min(16384, 4096 + 4500 * Math.max(1, images.length));

  // Étiquette de CHAQUE image (parallèle à `images`), utilisée par le backend
  // Claude (bloc texte avant chaque image) pour distinguer actuel / antérieur.
  const labels = [
    ...curSlices.map(n =>
      comparing ? `EXAMEN ACTUEL — Coupe n° ${n} :` : `Coupe n° ${n} :`
    ),
    ...priorSlices.map(
      n =>
        `EXAMEN ANTÉRIEUR${priorDate ? ` du ${priorDate}` : ""} — Coupe n° ${n} :`
    ),
  ];

  // Contexte de l'étude injecté pour ancrer le modèle.
  const ctxLines: string[] = [];
  if (opts.modality) ctxLines.push(`Modalité : ${opts.modality}`);
  if (opts.studyDescription) ctxLines.push(`Examen : ${opts.studyDescription}`);
  if (opts.indication)
    ctxLines.push(`Indication clinique : ${opts.indication}`);
  if (opts.antecedents)
    ctxLines.push(`Antécédents médicaux du patient : ${opts.antecedents}`);
  if (comparing) {
    const curTotal = opts.totalSlices ?? curImages.length;
    const priorTotal = opts.prior?.totalSlices ?? priorImages.length;
    ctxLines.push(
      `EXAMEN ACTUEL : ${curImages.length} coupe(s) (sur ${curTotal}), coupes n° ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      `EXAMEN ANTÉRIEUR${priorDate ? ` du ${priorDate}` : ""} : ${priorImages.length} coupe(s) (sur ${priorTotal}), coupes n° ${priorSlices.join(", ")}.`
    );
    ctxLines.push(
      `Compare les deux examens, rédige Technique / Résultats (avec un paragraphe « Comparaison à l'examen du ${priorDate ?? "précédent"} : … ») / Conclusion, puis Anomalie (oui/non), Coupe-clé, et enfin Évolution (stable/progression/régression).`
    );
  } else {
    const total = opts.totalSlices ?? images.length;
    ctxLines.push(
      `Échantillon de ${images.length} coupe(s) réparties sur les ${total} coupes du volume. Dans l'ordre, ces images correspondent aux coupes n° : ${curSlices.join(", ")}.`
    );
    ctxLines.push(
      "Analyse l'ensemble de ces coupes selon la méthode, rédige Technique / Résultats / Conclusion, puis indique Anomalie (oui/non) et le numéro de la Coupe-clé."
    );
  }
  const userText = ctxLines.join("\n");
  const system = comparing
    ? `${SYSTEM_PROMPT}\n${COMPARATIVE_ADDENDUM}`
    : SYSTEM_PROMPT;

  if (useClaude) {
    return generateViaClaude(images, userText, labels, system);
  }
  return generateViaOllama(images, userText, numCtx, system);
}

async function generateViaOllama(
  images: string[],
  userText: string,
  numCtx: number,
  system: string
): Promise<PreanalysisResult> {
  const model = ENV.ollamaVisionModel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  let content = "";
  try {
    const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        // GPU dédié : on garde le modèle chargé en VRAM (évite le warm-up ~67 s
        // au premier compte rendu). -1 = pas de déchargement.
        keep_alive: -1,
        options: { num_ctx: numCtx, num_predict: 512 },
        messages: [
          { role: "system", content: system },
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
    evolution: parseEvolution(content).evolution,
    model: ENV.ollamaVisionModel,
  };
}

async function generateViaClaude(
  images: string[],
  userText: string,
  labels: string[],
  system: string
): Promise<PreanalysisResult> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: ENV.anthropicApiKey });
  // On étiquette CHAQUE image (bloc texte juste avant l'image) pour que le
  // modèle puisse désigner la coupe-clé et l'examen d'appartenance sans ambiguïté.
  const content: any[] = [];
  images.forEach((b64, i) => {
    content.push({
      type: "text",
      text: labels[i] ?? `Coupe n° ${i + 1} :`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: b64 },
    });
  });
  content.push({ type: "text", text: userText });
  // Timeout explicite (audit I-claude-timeout) : sans borne, une requête Claude
  // (thinking adaptatif + jusqu'à 16 images) peut pendre et bloquer la requête
  // tRPC. Aligné sur le timeout de 180 s de la branche Ollama.
  const resp = await client.messages.create(
    {
      model: ENV.anthropicModel,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content }],
    },
    { timeout: 240_000 }
  );
  const text = (resp.content as any[])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
  return {
    ...parseSections(text),
    ...parseKeySlice(text),
    evolution: parseEvolution(text).evolution,
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
  // Antériorité à comparer (mesure d'évolution) ; absente → pas de comparaison.
  priorStudyId?: number;
  priorSeriesId?: number;
}

export interface RunAiPreanalysisResult extends PreanalysisResult {
  // Image de la coupe désignée par l'IA, rendue côté serveur, à retenir comme
  // image clé du compte rendu (null si pas d'anomalie / rendu impossible).
  keyImage?: { pngBase64: string; sliceIndex: number } | null;
  // Date (DICOM DA, brute) de l'antériorité réellement comparée, ou null.
  comparedPriorDate?: string | null;
}

export async function runAiPreanalysis(
  input: RunAiPreanalysisInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<RunAiPreanalysisResult> {
  // Signale une activité au plan de contrôle GPU : réarme le minuteur de mise en
  // veille pour que le GPU ne s'endorme pas pendant une séance de comptes rendus.
  // Best-effort (n'échoue jamais) ; no-op si le pilotage GPU n'est pas configuré.
  void (await import("./gpuControl")).gpuTouch();

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
        // Vision sur GPU : on analyse 16 coupes réparties sur tout le volume
        // (8 quand on compare une antériorité, pour partager le budget).
        count: input.sampleCount ?? (input.priorStudyId ? 8 : 16),
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

  // --- Antériorité (mesure d'évolution) : fail-soft de bout en bout. ---------
  let prior:
    | { images: PreanalysisKeyImage[]; date?: string; totalSlices?: number }
    | undefined;
  let comparedPriorDate: string | null = null;
  if (input.priorStudyId) {
    try {
      const priorStudy = await getStudyById(input.priorStudyId);
      if (priorStudy) {
        // Anti-IDOR : l'antériorité DOIT être du même patient (lève FORBIDDEN).
        assertSamePatientStudies(study as any, priorStudy as any);
        const priorSeriesList = await listSeriesByStudy(input.priorStudyId);
        const priorSeriesId =
          input.priorSeriesId &&
          priorSeriesList.some((s: any) => s.id === input.priorSeriesId)
            ? input.priorSeriesId
            : pickPriorSeriesId(
                priorSeriesList as any,
                (study as any).modality ?? null
              );
        if (priorSeriesId) {
          const { sampleSeriesPngs } = await import("./aiSampling");
          const sampledPrior = await sampleSeriesPngs(priorSeriesId, {
            windowCenter: wc,
            windowWidth: ww,
            count: 8,
          });
          if (sampledPrior.images.length > 0) {
            prior = {
              images: sampledPrior.images.map(s => ({
                pngBase64: s.pngBase64,
                sliceIndex: s.sliceNumber,
              })),
              date: (priorStudy as any).studyDate ?? undefined,
              totalSlices: sampledPrior.totalSlices,
            };
            comparedPriorDate = (priorStudy as any).studyDate ?? null;
          }
        }
      }
    } catch (e) {
      // FORBIDDEN (patient différent) doit remonter ; le reste est fail-soft.
      if (e instanceof TRPCError && e.code === "FORBIDDEN") throw e;
      console.warn("[aiPreanalysis] comparaison antériorité échouée:", e);
    }
  }

  const result = await _internal.generatePreanalysis(images, {
    indication: input.indication,
    antecedents: input.antecedents,
    modality: (study as any).modality ?? undefined,
    studyDescription: (study as any).studyDescription ?? undefined,
    totalSlices,
    prior,
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
  return { ...result, keyImage, comparedPriorDate };
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

// Extrait le verdict d'évolution comparative (ligne « Évolution: stable |
// progression | régression »). Tolérant à la casse et aux accents. Renvoie le
// texte NETTOYÉ de cette ligne (elle ne doit pas polluer la Conclusion) ;
// verdict null si la ligne est absente.
export function parseEvolution(text: string): {
  evolution: "stable" | "progression" | "regression" | null;
  cleaned: string;
} {
  const m = text.match(
    /\n?\s*[EÉeé]volution\s*:?\s*(stable|progression|régression|regression)\b/i
  );
  if (!m) return { evolution: null, cleaned: text };
  const raw = m[1].toLowerCase();
  const evolution =
    raw === "stable"
      ? "stable"
      : raw === "progression"
        ? "progression"
        : "regression";
  return { evolution, cleaned: text.replace(m[0], "").trimEnd() };
}

// Garde anti-IDOR : une antériorité ne peut être comparée que si elle appartient
// au MÊME patient que l'étude courante (sinon fuite PHI inter-patients). Lève
// FORBIDDEN sinon.
//
// Comparaison PRIMAIRE = `patientFk` (FK interne `patients.id`, vérité de la
// base) : immunisée contre les collisions de PatientID DICOM inter-sources (deux
// patients distincts pouvant partager un même PatientID si importés de sources
// hétérogènes). Repli = PatientID DICOM (trim) quand la FK n'est pas disponible
// (ex. appel avec des objets partiels) ; un id vide ne rapproche personne.
export function assertSamePatientStudies(
  current: { patientFk?: number | null; patientId?: string | null },
  prior: { patientFk?: number | null; patientId?: string | null }
): void {
  const forbidden = () => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "L'antériorité doit appartenir au même patient.",
    });
  };
  // Vérité DB : si les deux FK internes sont connues, elles font foi.
  if (current.patientFk != null && prior.patientFk != null) {
    if (current.patientFk !== prior.patientFk) forbidden();
    return;
  }
  // Repli : PatientID DICOM.
  const a = (current.patientId ?? "").trim();
  const b = (prior.patientId ?? "").trim();
  if (a === "" || b === "" || a !== b) forbidden();
}

// Série de l'antériorité à comparer : 1re série de MÊME modalité que la
// courante si elle existe, sinon la 1re série, sinon null. Fonction pure.
export function pickPriorSeriesId(
  series:
    | readonly { id: number; modality?: string | null }[]
    | null
    | undefined,
  currentModality?: string | null
): number | null {
  if (!series || series.length === 0) return null;
  const wanted = (currentModality ?? "").trim().toUpperCase();
  if (wanted) {
    const m = series.find(
      s => (s.modality ?? "").trim().toUpperCase() === wanted
    );
    if (m) return m.id;
  }
  return series[0].id;
}

export function parseSections(text: string): {
  technique: string;
  resultats: string;
  conclusion: string;
} {
  // On retire d'abord les lignes méta finales (Anomalie / Coupe-clé) pour
  // qu'elles ne soient pas absorbées dans la Conclusion.
  const cut = text.search(
    /\n\s*(Anomalie|Coupe[-\s]?cl[ée]|[EÉeé]volution)\s*:/i
  );
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
