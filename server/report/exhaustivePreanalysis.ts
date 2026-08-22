import { randomUUID } from "crypto";
import { ENV } from "../_core/env";
import {
  getStudyById,
  createAiJob,
  finishAiJob,
  failAiJob,
  getAiJob,
} from "../db";
import {
  sampleSeriesPngs,
  renderSliceByNumber,
  pickSampleIndices,
} from "./aiSampling";
import { geminiVision, geminiVisionConfigured } from "./geminiVision";
import { secondReadGemini, reconcileReads } from "./doubleLecture";
import {
  generatePreanalysis,
  extractBurnedInText,
  locateAnomaly,
  zoomReadAnomaly,
  verifyConclusion,
  secondOpinionAbnormal,
  downscalePngBase64,
  isDiagnosticSeries,
  resolveDiagnosticTarget,
  type PreanalysisResult,
  type PreanalysisKeyImage,
} from "./aiPreanalysis";

interface SeriesMeta {
  id: number;
  seriesDescription?: string | null;
  modality?: string | null;
  numberOfInstances?: number | null;
  seriesNumber?: number | null;
}

function seriesLabelOf(s: SeriesMeta): string {
  return `${s.seriesDescription || `Série ${s.seriesNumber ?? s.id}`} — ${s.modality || "?"}`;
}

/**
 * Choisit les séries à balayer en analyse EXHAUSTIVE, sans jamais « lire » un
 * scanogramme (root cause des CR faux — cf. resolveDiagnosticTarget). PURE.
 *  - wholeStudy : toutes les séries DIAGNOSTIQUES (scano/SUMMARY exclus) ; si
 *    aucune → `refuse` (l'appelant renvoie un refus honnête, pas un CR sur scout) ;
 *  - série unique : redirige un scano vers la plus grosse série diagnostique, ou
 *    refuse si l'étude n'a aucune coupe.
 */
export function selectExhaustiveSeries(
  input: { seriesId?: number | null; wholeStudy?: boolean },
  allSeries: readonly SeriesMeta[]
): { refuse: boolean; series: { id: number; label?: string; n: number }[] } {
  const target = resolveDiagnosticTarget(
    { seriesId: input.wholeStudy ? null : input.seriesId },
    allSeries
  );
  if (target.refuse) return { refuse: true, series: [] };
  if (input.wholeStudy) {
    const diag = allSeries.filter(isDiagnosticSeries);
    return {
      refuse: false,
      series: diag.map(s => ({
        id: s.id,
        label: seriesLabelOf(s),
        n: s.numberOfInstances ?? 0,
      })),
    };
  }
  const sid = target.seriesId ?? input.seriesId ?? 0;
  const meta = allSeries.find(s => s.id === sid);
  return {
    refuse: false,
    series: [
      {
        id: sid,
        label: meta ? seriesLabelOf(meta) : undefined,
        n: meta?.numberOfInstances ?? 0,
      },
    ],
  };
}

/**
 * Analyse EXHAUSTIVE : balaye TOUTES les coupes de la série (pas un échantillon).
 *
 * Phase 1 (dépistage) : chaque coupe est vue par le modèle vision, par lots, en
 * basse résolution → repère les coupes suspectes (couverture 100 %).
 * Phase 2 (rapport)   : rapport détaillé sur les coupes suspectes (+ quelques
 * représentatives), en pleine résolution.
 *
 * Longue (~10-15 min) → exécutée en tâche de fond ; le client sonde l'avancement.
 * NON certifié : couverture complète ≠ niveau expert ; à valider par le médecin.
 */

export interface ExhaustiveResult extends PreanalysisResult {
  screenedSlices: number;
  flaggedSlices: number[];
  secondOpinion?: {
    abnormal: boolean | null;
    model: string;
    agree: boolean;
    // Double lecture croisée (Gemini) : lecture complète du 2e lecteur +
    // synthèse de réconciliation rédigée par le 1er (champs absents en repli
    // local oui/non — rétro-compatible client).
    resultats?: string;
    conclusion?: string;
    reconciliation?: string;
  } | null;
}
interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: { done: number; total: number };
  // Étape courante (Story 4.1) : sans elle, l'UI affiche « 0/N » pendant le
  // long rendu initial des coupes et l'utilisateur croit que c'est figé.
  phase?: string;
  result?: ExhaustiveResult;
  error?: string;
  startedAt: number;
}
const JOBS = new Map<string, Job>();

// Purge les jobs de plus d'1 h (évite la fuite mémoire).
function gc() {
  const now = Date.now();
  JOBS.forEach((j, id) => {
    if (now - j.startedAt > 3600_000) JOBS.delete(id);
  });
}

/**
 * Extrait les numéros de coupes suspectes d'une réponse de dépistage : chiffres
 * filtrés par la liste des numéros réellement montrés, dédupliqués. « RAS » ou
 * réponse vide → aucun. PURE.
 */
export function parseScreenReply(
  txt: string,
  allowed: readonly number[]
): number[] {
  const nums = (txt.match(/\d+/g) ?? []).map(Number);
  const ok = new Set(allowed);
  return Array.from(new Set(nums.filter(n => ok.has(n))));
}

const SCREEN_SYS = [
  "Tu es un assistant de DÉPISTAGE rapide en imagerie. On te donne des coupes NUMÉROTÉES d'un même examen.",
  "Indique UNIQUEMENT les numéros des coupes où une anomalie est POSSIBLE (fracture, lésion, masse, hémorragie, asymétrie nette).",
  "Sois SÉLECTIF : ne signale que ce qui est franchement suspect. En cas de doute léger, n'inclus pas.",
  "Réponds STRICTEMENT par les numéros séparés par des virgules (ex. « 142, 143, 210 »), ou « RAS » si rien.",
].join(" ");

async function screenBatch(
  batch: { pngBase64: string; sliceNumber: number }[],
  modality?: string
): Promise<number[]> {
  const labels = batch.map(b => b.sliceNumber);
  const userText = `Coupes fournies, dans l'ordre : n° ${labels.join(", ")}.${
    modality ? ` Modalité : ${modality}.` : ""
  } Quels numéros sont suspects ?`;
  // Dépistage cloud (Gemini Flash, Vertex UE) quand configuré + consentement
  // PHI : bien meilleur que le petit modèle local — c'est LE goulot de qualité
  // de l'exhaustif. Échec/absence de config → repli qwen local (jamais de
  // panne sèche).
  if (geminiVisionConfigured()) {
    const txt = await geminiVision({
      model: ENV.geminiScreenModel,
      system: SCREEN_SYS,
      userText,
      pngBase64: batch.map(b => b.pngBase64),
      maxTokens: 100,
    });
    if (txt !== null) return parseScreenReply(txt, labels);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(`${ENV.ollamaVisionUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ENV.ollamaVisionModel,
        stream: false,
        keep_alive: -1,
        options: { num_ctx: 8192, num_predict: 80 },
        messages: [
          { role: "system", content: SCREEN_SYS },
          {
            role: "user",
            content: userText,
            images: batch.map(b => b.pngBase64),
          },
        ],
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const txt: string = data?.message?.content ?? "";
    return parseScreenReply(txt, labels);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function runExhaustive(
  job: Job,
  input: {
    studyId: number;
    seriesId: number;
    windowCenter: number;
    windowWidth: number;
    indication?: string;
    antecedents?: string;
    wholeStudy?: boolean;
  }
) {
  const study = await getStudyById(input.studyId);
  const modality = (study as any)?.modality ?? undefined;
  const wc = input.windowCenter;
  const ww = input.windowWidth;

  // Séries à balayer, SANS jamais « lire » un scanogramme (cf.
  // selectExhaustiveSeries) : étude sans coupes diagnostiques → refus honnête
  // (pas de CR faux ni de fausse anomalie sur des images de repérage).
  const { listSeriesByStudy } = await import("../db");
  const allStudySeries = (await listSeriesByStudy(input.studyId)) as any[];
  const picked = selectExhaustiveSeries(
    { seriesId: input.seriesId, wholeStudy: input.wholeStudy },
    allStudySeries
  );
  if (picked.refuse) {
    job.result = {
      technique: "",
      resultats:
        "Aucune série de coupes diagnostique disponible pour cette étude : " +
        "seules des images de repérage (scanogramme) et/ou des rapports de " +
        "synthèse (SUMMARY) sont présentes. L'analyse n'a pas été effectuée.",
      conclusion:
        "Analyse impossible : l'import de cette étude est incomplet (aucune " +
        "série de coupes). Vérifier le rapatriement PACS avant toute lecture.",
      model: "aucun — pas de série diagnostique",
      keySliceNumber: null,
      abnormal: false,
      evolution: null,
      screenedSlices: 0,
      flaggedSlices: [],
      secondOpinion: null,
    };
    job.status = "done";
    await finishAiJob(job.id, job.result);
    return;
  }
  const series = picked.series;

  // Phase 1 : DÉPISTAGE — chaque coupe de CHAQUE série, basse résolution.
  job.progress = {
    done: 0,
    total: series.reduce((a, s) => a + Math.max(1, s.n), 0),
  };
  // Dépistage cloud (Gemini Flash) : 512 px / lots de 16 — le modèle cloud lit
  // mieux et tient plus d'images par appel. Repli local (qwen) : 384 px / 12,
  // pour ne pas saturer le contexte du petit modèle.
  const cloudScreen = geminiVisionConfigured();
  const SCREEN_DIM = cloudScreen ? 512 : 384;
  const BATCH = cloudScreen ? 16 : 12;
  let screenedTotal = 0;
  const flaggedBy = new Map<
    number,
    { label?: string; nums: Set<number>; total: number }
  >();
  let siNum = 0;
  for (const s of series) {
    siNum += 1;
    const siLabel =
      series.length > 1 ? ` (série ${siNum}/${series.length})` : "";
    // Le rendu de TOUTES les coupes précède la boucle de dépistage : phase
    // explicite pour que « 0/N » ne passe pas pour un blocage.
    job.phase = `Rendu des coupes${siLabel}…`;
    let all;
    try {
      all = await sampleSeriesPngs(s.id, {
        windowCenter: wc,
        windowWidth: ww,
        count: 1_000_000,
        maxDim: SCREEN_DIM,
      });
    } catch {
      continue;
    }
    if (all.images.length === 0) continue;
    screenedTotal += all.images.length;
    const flagged = new Set<number>();
    for (let b = 0; b < all.images.length; b += BATCH) {
      job.phase = `Dépistage${siLabel}…`;
      const batch = all.images.slice(b, b + BATCH);
      (await screenBatch(batch, modality)).forEach(n => flagged.add(n));
      job.progress.done += batch.length;
    }
    flaggedBy.set(s.id, {
      label: s.label,
      nums: flagged,
      total: all.images.length,
    });
  }
  if (screenedTotal === 0) throw new Error("Aucune coupe rendable");

  // Phase 2 : coupes suspectes de TOUTES les séries (réparties, total ≤ 30) ;
  // représentatives si une série n'a rien de suspect. Pleine résolution.
  job.phase = "Rédaction du rapport…";
  const CAP = 30;
  const entries = Array.from(flaggedBy.entries());
  const perSeriesCap = Math.max(
    4,
    Math.floor(CAP / Math.max(1, entries.length))
  );
  const keyImgs: PreanalysisKeyImage[] = [];
  for (const [sid, f] of entries) {
    if (keyImgs.length >= CAP) break;
    let nums = Array.from(f.nums)
      .sort((a, b) => a - b)
      .slice(0, perSeriesCap);
    if (nums.length === 0) nums = pickSampleIndices(f.total, 3).map(i => i + 1);
    for (const n of nums) {
      if (keyImgs.length >= CAP) break;
      const b64 = await renderSliceByNumber(sid, n, {
        windowCenter: wc,
        windowWidth: ww,
      });
      if (b64)
        keyImgs.push({ pngBase64: b64, sliceIndex: n, seriesLabel: f.label });
    }
  }

  // Mesures : segmentation (volumes d'organes) de la série CT la plus grosse.
  let measurements: string | undefined;
  if ((modality ?? "").toUpperCase() === "CT" && ENV.segServiceUrl) {
    const mainCt = entries.sort((a, b) => b[1].total - a[1].total)[0];
    if (mainCt) {
      try {
        const { segmentCtSeries } = await import("./ctSegmentation");
        const seg = await segmentCtSeries(mainCt[0], { highRes: true });
        if (seg.structures.length)
          measurements = seg.structures
            .slice(0, 30)
            .map((x: any) => `${x.name}: ${x.volumeMl} mL`)
            .join(" ; ");
      } catch {
        /* fail-soft */
      }
    }
  }

  const cloudVision =
    ENV.aiBackend === "claude" &&
    !!ENV.anthropicApiKey &&
    ENV.cloudAiPhiConsent;

  // OCR des mesures/repères incrustés (comme le mode max) → ancré dans le CR.
  let screenText: string | undefined;
  try {
    screenText =
      (await extractBurnedInText(keyImgs, { cloud: cloudVision })) ?? undefined;
  } catch {
    /* fail-soft */
  }

  const result = await generatePreanalysis(keyImgs, {
    indication: input.indication,
    antecedents: input.antecedents,
    modality,
    studyDescription: (study as any)?.studyDescription ?? undefined,
    totalSlices: screenedTotal,
    measurements,
    screenText,
    maxImages: CAP,
  });

  // Re-zoom HD sur la zone suspecte + vérification critique (comme le mode max),
  // quand une anomalie est signalée. Annexés au CR (à valider). Fail-soft.
  if (result.abnormal === true && keyImgs.length > 0) {
    const key =
      keyImgs.find(k => k.sliceIndex === result.keySliceNumber) ?? keyImgs[0];
    try {
      const box = await locateAnomaly(key.pngBase64, { cloud: cloudVision });
      if (box) {
        const zoom = await zoomReadAnomaly(
          key.pngBase64,
          box,
          modality,
          cloudVision
        );
        if (zoom)
          result.resultats =
            `${result.resultats}\n\nAnalyse ciblée (zoom haute résolution sur la zone suspecte, à valider) : ${zoom}`.trim();
      }
    } catch {
      /* fail-soft */
    }
    try {
      const v = await verifyConclusion(
        keyImgs
          .slice(0, cloudVision ? 6 : 4)
          .map(k => downscalePngBase64(k.pngBase64, cloudVision ? 1024 : 768)),
        result.conclusion,
        modality,
        cloudVision
      );
      if (v)
        result.resultats =
          `${result.resultats}\n\nVérification (2e lecture critique indépendante, à valider) : ${v}`.trim();
    } catch {
      /* fail-soft */
    }
  }

  // Double lecture croisée : relecture COMPLÈTE et indépendante par Gemini
  // (Vertex UE), puis réconciliation rédigée par le 1er lecteur (Opus) —
  // désaccords = points de vigilance dans le CR. Repli : l'ancienne 2e opinion
  // locale (oui/non) si Gemini indisponible. Tout est fail-soft.
  let secondOpinion: ExhaustiveResult["secondOpinion"] = null;
  try {
    const sr = await secondReadGemini(keyImgs, {
      indication: input.indication,
      modality,
      measurements,
      totalSlices: screenedTotal,
    });
    if (sr) {
      const rec = await reconcileReads(
        {
          resultats: result.resultats,
          conclusion: result.conclusion,
          model: result.model,
        },
        sr
      );
      secondOpinion = {
        abnormal: sr.abnormal,
        model: sr.model,
        agree:
          rec?.agree ??
          (sr.abnormal !== null && sr.abnormal === (result.abnormal ?? null)),
        resultats: sr.resultats,
        conclusion: sr.conclusion,
        reconciliation: rec?.section,
      };
      if (rec?.section) {
        result.resultats =
          `${result.resultats}\n\nDouble lecture (${result.model} × ${sr.model}) :\n${rec.section}`.trim();
      }
    } else {
      const ab2 = await secondOpinionAbnormal(keyImgs, modality, false);
      secondOpinion = {
        abnormal: ab2,
        model: ENV.ollamaVisionModel2,
        agree: ab2 !== null && ab2 === (result.abnormal ?? null),
      };
    }
  } catch {
    /* fail-soft */
  }

  const allFlagged: number[] = [];
  flaggedBy.forEach(f => f.nums.forEach(n => allFlagged.push(n)));
  job.result = {
    ...result,
    screenedSlices: screenedTotal,
    flaggedSlices: Array.from(new Set(allFlagged)).sort((a, b) => a - b),
    secondOpinion,
  };
  job.status = "done";
  // Persiste le résultat final → survit à un redémarrage (le client le récupère).
  await finishAiJob(job.id, job.result);
}

export async function startExhaustiveJob(input: {
  studyId: number;
  seriesId: number;
  windowCenter: number;
  windowWidth: number;
  indication?: string;
  antecedents?: string;
  wholeStudy?: boolean;
}): Promise<{ jobId: string }> {
  gc();
  const jobId = randomUUID();
  const job: Job = {
    id: jobId,
    status: "running",
    progress: { done: 0, total: 0 },
    startedAt: Date.now(),
  };
  JOBS.set(jobId, job);
  // Persiste l'état « running » AVANT de lancer → au redémarrage, le boot le
  // marquera « error » (interrompu) au lieu d'un « Job inconnu » côté client.
  await createAiJob(jobId, input.studyId);
  // Lancement en tâche de fond (pas d'await) ; le client sonde l'avancement.
  runExhaustive(job, input).catch(e => {
    job.status = "error";
    job.error = String(e?.message ?? e).slice(0, 300);
    void failAiJob(jobId, job.error);
  });
  return { jobId };
}

export async function getExhaustiveJob(jobId: string) {
  // Mémoire d'abord (avancement live). Sinon base : un job lancé avant un
  // redémarrage y est marqué « error » (interrompu) → le client peut relancer.
  const j = JOBS.get(jobId);
  if (j) {
    return {
      status: j.status,
      progress: j.progress,
      phase: j.phase,
      result: j.result,
      error: j.error,
    };
  }
  const persisted = await getAiJob(jobId);
  if (persisted) {
    return {
      status: persisted.status,
      progress: persisted.progress,
      result: persisted.result as ExhaustiveResult | undefined,
      error: persisted.error,
    };
  }
  return { status: "error" as const, error: "Job inconnu (expiré ?)" };
}
