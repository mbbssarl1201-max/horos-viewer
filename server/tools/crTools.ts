import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db";
import { reports, studies } from "../../drizzle/schema";

type PendingItem = {
  reportId: number;
  studyId: number;
  modality: string | null;
  studyDate: string | null;
};

export async function listPendingSignaturesFn(): Promise<{
  pending: PendingItem[];
}> {
  const db = await getDb();
  if (!db) return { pending: [] };
  const rows = await db
    .select({
      reportId: reports.id,
      studyId: reports.studyId,
      modality: studies.modality,
      studyDate: studies.studyDate,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id))
    .where(and(eq(reports.status, "draft"), eq(reports.aiGenerated, true)))
    .orderBy(desc(reports.createdAt))
    .limit(10);
  return { pending: rows };
}

export async function getCRDraftFn(args: { studyId: number }): Promise<{
  found: boolean;
  status?: string;
  draftText?: string;
  modality?: string | null;
  studyDate?: string | null;
}> {
  const db = await getDb();
  if (!db) return { found: false };
  const rows = await db
    .select({
      id: reports.id,
      status: reports.status,
      resultats: reports.resultats,
      conclusion: reports.conclusion,
      modality: studies.modality,
      studyDate: studies.studyDate,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id))
    .where(eq(reports.studyId, args.studyId))
    .orderBy(desc(reports.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return { found: false };
  const draftText = [
    r.resultats ? `Résultats : ${r.resultats}` : "",
    r.conclusion ? `Conclusion : ${r.conclusion}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    found: true,
    status: r.status,
    draftText,
    modality: r.modality,
    studyDate: r.studyDate,
  };
}

export async function requestCRGenerationFn(args: {
  studyId: number;
}): Promise<{
  alreadyExists: boolean;
  jobStarted: boolean;
  status?: string;
  expectedDelaySeconds?: number;
}> {
  const db = await getDb();
  if (!db) return { alreadyExists: false, jobStarted: false };
  // Checks for ANY existing report (draft or signed). If signed, Hermès receives
  // alreadyExists: true + status: "signed", letting it inform the user instead
  // of triggering a duplicate generation.
  const existing = await db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(eq(reports.studyId, args.studyId))
    .limit(1);
  if (existing[0]) {
    return {
      alreadyExists: true,
      jobStarted: false,
      status: existing[0].status,
    };
  }
  // runAgentOnce() processes ALL studies pending generation (no studyId targeting).
  // The requested study will be among them; delay may exceed expectedDelaySeconds
  // if there is a queue.
  const { runAgentOnce } = await import("../report/autoReportAgent");
  runAgentOnce().catch(e =>
    console.warn("[crTool] requestCRGeneration failed:", (e as Error)?.message)
  );
  return { alreadyExists: false, jobStarted: true, expectedDelaySeconds: 30 };
}
