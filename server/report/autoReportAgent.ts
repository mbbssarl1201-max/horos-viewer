import { ENV } from "../_core/env";
import {
  getAgentSettings,
  setAgentLastRun,
  findStudyIdsNeedingReport,
  countAiReportsSince,
  getStudyById,
  listSeriesByStudy,
  getReportByStudy,
  getDb,
} from "../db";

const MAX_PER_RUN = 10; // garde-fou de charge par passe

export function computeBatchSize(opts: {
  dailyCap: number;
  generatedToday: number;
}): number {
  const remaining = Math.max(0, opts.dailyCap - opts.generatedToday);
  return Math.min(MAX_PER_RUN, remaining);
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Génère un brouillon pour une étude (idempotent : skip si report existe). */
async function generateForStudy(studyId: number): Promise<boolean> {
  if (await getReportByStudy(studyId)) return false;
  const series = (await listSeriesByStudy(studyId)) as any[];
  if (!series.length) return false;
  const { runAiPreanalysis } = await import("./aiPreanalysis");
  await getStudyById(studyId);
  const res = await runAiPreanalysis(
    {
      studyId,
      seriesId: series[0].id,
      keyImages: [],
      wholeStudy: true,
      deepAnalysis: true,
    } as any,
    { user: { id: 0, name: "Agent CR" } } as any
  );
  if (await getReportByStudy(studyId)) return false; // course
  const db = await getDb();
  if (!db) return false;
  const { reports } = await import("../../drizzle/schema");
  await db.insert(reports).values({
    studyId,
    status: "draft",
    indication: (res as any).indication ?? "",
    technique: (res as any).technique ?? "",
    resultats: (res as any).resultats ?? "",
    conclusion: (res as any).conclusion ?? "",
    aiGenerated: true,
    aiModel: (res as any).model ?? null,
    createdBy: 0,
  });
  return true;
}

/** Une passe de l'agent : génère jusqu'au plafond restant du jour. */
export async function runAgentOnce(): Promise<{ generated: number }> {
  const settings = await getAgentSettings();
  if (!settings?.enabled || !settings.enabledAt) return { generated: 0 };
  const generatedToday = await countAiReportsSince(startOfToday());
  const batch = computeBatchSize({
    dailyCap: settings.dailyCap,
    generatedToday,
  });
  if (batch <= 0) {
    await setAgentLastRun();
    return { generated: 0 };
  }
  const ids = await findStudyIdsNeedingReport(settings.enabledAt, batch);
  let generated = 0;
  for (const id of ids) {
    try {
      if (await generateForStudy(id)) generated++;
    } catch (e) {
      console.warn(`[agent] échec étude ${id}:`, (e as Error)?.message);
    }
  }
  await setAgentLastRun();
  return { generated };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Démarre le worker périodique (fail-soft, jamais throw). */
export function startAutoReportAgent(): void {
  if (timer || ENV.agentPollMs <= 0) return;
  timer = setInterval(() => {
    runAgentOnce().catch(e =>
      console.warn("[agent] passe échouée:", (e as Error)?.message)
    );
  }, ENV.agentPollMs);
  if (typeof timer.unref === "function") timer.unref();
}
