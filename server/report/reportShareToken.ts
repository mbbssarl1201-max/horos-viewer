import { randomBytes } from "crypto";
import { getDb } from "../db";
import { reportShareTokens } from "../../drizzle/schema";
import { eq, and, gt, isNull } from "drizzle-orm";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function createShareToken(
  reportId: number,
  studyId: number,
  recipientEmail: string
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);
  await db.insert(reportShareTokens).values({
    token,
    reportId,
    studyId,
    recipientEmail,
    expiresAt,
  });
  return token;
}

export async function resolveShareToken(token: string): Promise<{
  reportId: number;
  studyId: number;
  recipientEmail: string;
} | null> {
  const db = await getDb();
  if (!db) return null;
  const now = new Date();
  const rows = await db
    .select()
    .from(reportShareTokens)
    .where(
      and(
        eq(reportShareTokens.token, token),
        gt(reportShareTokens.expiresAt, now),
        isNull(reportShareTokens.usedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Marquer comme utilisé (usage unique)
  await db
    .update(reportShareTokens)
    .set({ usedAt: now })
    .where(eq(reportShareTokens.id, row.id));
  return {
    reportId: row.reportId,
    studyId: row.studyId,
    recipientEmail: row.recipientEmail,
  };
}
