import { getDb } from "../db";
import {
  agentState,
  agentActivity,
  agentNotes,
  reportAiSnapshots,
} from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

export async function getAgentState(agentKey: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(agentState)
    .where(eq(agentState.agentKey, agentKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function setAgentState(
  agentKey: string,
  patch: { enabled?: boolean; targetsJson?: string; lastError?: string | null }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getAgentState(agentKey);
  if (existing) {
    await db
      .update(agentState)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentState.agentKey, agentKey));
  } else {
    await db.insert(agentState).values({
      agentKey,
      enabled: patch.enabled ?? false,
      targetsJson: patch.targetsJson ?? null,
    });
  }
}

export async function logAgentActivity(
  agentKey: string,
  action: string,
  status: "ok" | "error" | "skipped",
  opts?: { studyId?: number; detail?: string }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(agentActivity).values({
      agentKey,
      action,
      status,
      studyId: opts?.studyId ?? null,
      detail: opts?.detail?.slice(0, 512) ?? null,
    });
    if (status === "error") {
      await setAgentState(agentKey, {
        lastError: opts?.detail?.slice(0, 512) ?? "error",
      });
    }
  } catch {
    /* best-effort */
  }
}

export async function listAgentActivity(
  agentKey: string | undefined,
  limit = 50
) {
  const db = await getDb();
  if (!db) return [];
  if (agentKey) {
    return db
      .select()
      .from(agentActivity)
      .where(eq(agentActivity.agentKey, agentKey))
      .orderBy(desc(agentActivity.createdAt))
      .limit(limit);
  }
  return db
    .select()
    .from(agentActivity)
    .orderBy(desc(agentActivity.createdAt))
    .limit(limit);
}

export async function addAgentNote(
  agentKey: string,
  note: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(agentNotes).values({ agentKey, note });
}

export async function getAgentNotes(
  agentKey: string,
  limit = 10
): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(agentNotes)
    .where(eq(agentNotes.agentKey, agentKey))
    .orderBy(desc(agentNotes.createdAt))
    .limit(limit);
  return rows.map(r => r.note);
}

export async function recordReportSnapshot(
  studyId: number,
  sections: {
    indication: string;
    technique: string;
    resultats: string;
    conclusion: string;
  },
  model: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(reportAiSnapshots).values({
      studyId,
      sectionsJson: JSON.stringify(sections),
      model,
    });
  } catch {
    /* studyId unique : déjà capturé → ignore */
  }
}

export async function getReportSnapshot(studyId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(reportAiSnapshots)
    .where(eq(reportAiSnapshots.studyId, studyId))
    .limit(1);
  return rows[0] ?? null;
}
