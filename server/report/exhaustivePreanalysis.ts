import { randomUUID } from "crypto";
import { ENV } from "../_core/env";
import { getStudyById } from "../db";
import {
  sampleSeriesPngs,
  renderSliceByNumber,
  pickSampleIndices,
} from "./aiSampling";
import {
  generatePreanalysis,
  type PreanalysisResult,
  type PreanalysisKeyImage,
} from "./aiPreanalysis";

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
}
interface Job {
  status: "running" | "done" | "error";
  progress: { done: number; total: number };
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
    const nums = (txt.match(/\d+/g) ?? []).map(Number);
    const allowed = new Set(labels);
    return Array.from(new Set(nums.filter(n => allowed.has(n))));
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
  }
) {
  const study = await getStudyById(input.studyId);
  const modality = (study as any)?.modality ?? undefined;
  const wc = input.windowCenter;
  const ww = input.windowWidth;

  // Phase 1 : rendre TOUTES les coupes en basse résolution (dépistage).
  const all = await sampleSeriesPngs(input.seriesId, {
    windowCenter: wc,
    windowWidth: ww,
    count: 1_000_000, // ≥ total → toutes les coupes
    maxDim: 256,
  });
  job.progress = { done: 0, total: all.images.length };
  if (all.images.length === 0) throw new Error("Série non rendable");

  const BATCH = 20;
  const flagged = new Set<number>();
  for (let b = 0; b < all.images.length; b += BATCH) {
    const batch = all.images.slice(b, b + BATCH);
    (await screenBatch(batch, modality)).forEach(n => flagged.add(n));
    job.progress.done = Math.min(b + BATCH, all.images.length);
  }

  // Phase 2 : coupes à détailler = suspectes (max 16) + représentatives si peu.
  let reportNums = Array.from(flagged)
    .sort((a, b) => a - b)
    .slice(0, 16);
  if (reportNums.length < 6) {
    const repIdx = pickSampleIndices(all.images.length, 6);
    for (const i of repIdx) {
      const n = all.images[i].sliceNumber;
      if (!reportNums.includes(n)) reportNums.push(n);
    }
    reportNums.sort((a, b) => a - b);
  }

  // Rendu pleine résolution des coupes retenues.
  const keyImgs: PreanalysisKeyImage[] = [];
  for (const n of reportNums) {
    const b64 = await renderSliceByNumber(input.seriesId, n, {
      windowCenter: wc,
      windowWidth: ww,
    });
    if (b64) keyImgs.push({ pngBase64: b64, sliceIndex: n });
  }

  const result = await generatePreanalysis(keyImgs, {
    indication: input.indication,
    antecedents: input.antecedents,
    modality,
    studyDescription: (study as any)?.studyDescription ?? undefined,
    totalSlices: all.totalSlices,
  });

  job.result = {
    ...result,
    screenedSlices: all.images.length,
    flaggedSlices: Array.from(flagged).sort((a, b) => a - b),
  };
  job.status = "done";
}

export function startExhaustiveJob(input: {
  studyId: number;
  seriesId: number;
  windowCenter: number;
  windowWidth: number;
  indication?: string;
  antecedents?: string;
}): { jobId: string } {
  gc();
  const jobId = randomUUID();
  const job: Job = {
    status: "running",
    progress: { done: 0, total: 0 },
    startedAt: Date.now(),
  };
  JOBS.set(jobId, job);
  // Lancement en tâche de fond (pas d'await) ; le client sonde l'avancement.
  runExhaustive(job, input).catch(e => {
    job.status = "error";
    job.error = String(e?.message ?? e).slice(0, 300);
  });
  return { jobId };
}

export function getExhaustiveJob(jobId: string) {
  const j = JOBS.get(jobId);
  if (!j) return { status: "error" as const, error: "Job inconnu (expiré ?)" };
  return {
    status: j.status,
    progress: j.progress,
    result: j.result,
    error: j.error,
  };
}
