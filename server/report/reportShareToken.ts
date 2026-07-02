import { randomBytes } from "crypto";
import { getDb } from "../db";
import { reportShareTokens } from "../../drizzle/schema";
import { eq, and, gt, isNull } from "drizzle-orm";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShareTokenPayload {
  reportId: number;
  studyId: number;
  recipientEmail: string;
}

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

/**
 * Valide un token SANS le consommer (lecture seule). À utiliser sur les requêtes
 * GET (ex. `/r/:token`) : un GET ne doit jamais muter d'état, sinon les scanners
 * de liens (Outlook SafeLinks & co) qui pré-chargent les URL brûlent le token
 * avant le clic humain. La consommation « usage unique » n'a lieu qu'au moment
 * où l'accès est réellement accordé — voir `consumeShareToken`.
 */
export async function peekShareToken(
  token: string
): Promise<ShareTokenPayload | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(reportShareTokens)
    .where(
      and(
        eq(reportShareTokens.token, token),
        gt(reportShareTokens.expiresAt, new Date()),
        isNull(reportShareTokens.usedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    reportId: row.reportId,
    studyId: row.studyId,
    recipientEmail: row.recipientEmail,
  };
}

/**
 * Consomme le token de façon ATOMIQUE (usage unique). Le `UPDATE … WHERE
 * used_at IS NULL` garantit qu'un seul appelant concurrent l'emporte (verrou de
 * ligne MySQL) : `affectedRows === 1` pour le gagnant, 0 pour les autres → pas de
 * TOCTOU (F4). Ne doit être appelé qu'une fois l'accès accordé, après
 * vérification du destinataire (challenge OTP — F1, à câbler). Renvoie le
 * payload, ou null si le token est inconnu / expiré / déjà utilisé / a perdu une
 * course concurrente.
 */
export async function consumeShareToken(
  token: string
): Promise<ShareTokenPayload | null> {
  const db = await getDb();
  if (!db) return null;
  const now = new Date();
  const res = await db
    .update(reportShareTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(reportShareTokens.token, token),
        gt(reportShareTokens.expiresAt, now),
        isNull(reportShareTokens.usedAt)
      )
    );
  // mysql2 : le résultat est [ResultSetHeader, ...] → affectedRows sur res[0].
  const affected = (res as unknown as Array<{ affectedRows?: number }>)[0]
    ?.affectedRows;
  if (affected !== 1) return null;
  const rows = await db
    .select()
    .from(reportShareTokens)
    .where(eq(reportShareTokens.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    reportId: row.reportId,
    studyId: row.studyId,
    recipientEmail: row.recipientEmail,
  };
}
