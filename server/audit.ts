// Audit-log export + retention helpers.
//
// access_logs is the HIPAA / nLPD audit trail (append-only). These helpers let
// an administrator EXPORT the trail (CSV / rows) and PURGE rows past a
// retention window. Destructive actions are admin-only and never auto-run.

import type { AccessLog } from "../drizzle/schema";

// --- Pure helpers (unit-tested, no DB) ---------------------------------------

/**
 * Cutoff instant for retention: rows strictly OLDER than `days` days before
 * `now` are eligible for deletion. Pure & deterministic.
 */
export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Minimum retention window, in days. Guards against an accidental wipe. */
export const MIN_RETENTION_DAYS = 30;

/** Hard cap on rows returned by a single export call. */
export const AUDIT_EXPORT_MAX = 5000;

type CsvRow = Pick<
  AccessLog,
  "id" | "userId" | "action" | "studyId" | "detail" | "ipAddress" | "createdAt"
>;

/** Escape one CSV field per RFC 4180 (quote if it contains "," / '"' / newline). */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Anti-injection de formule (CSV injection) : un champ commençant par = + - @
  // ou une tabulation s'exécute comme formule dans Excel/LibreOffice. Ces valeurs
  // proviennent d'en-têtes attaquables (ex. X-Forwarded-For journalisé) ; on les
  // neutralise en les préfixant d'une apostrophe. Victime = l'admin qui exporte.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render access-log rows as a CSV document (header + rows). Pure — easy to
 * unit test and reused by the authenticated export route.
 */
export function buildAuditCsv(rows: CsvRow[]): string {
  const header = [
    "id",
    "userId",
    "action",
    "studyId",
    "detail",
    "ipAddress",
    "createdAt",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.userId),
        csvField(r.action),
        csvField(r.studyId),
        csvField(r.detail),
        csvField(r.ipAddress),
        csvField(r.createdAt),
      ].join(",")
    );
  }
  return lines.join("\n");
}

// --- DB-touching helpers -----------------------------------------------------

export interface AuditExportFilter {
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Read access_logs rows for export, most recent first, capped at
 * AUDIT_EXPORT_MAX. Optional [from, to] window on createdAt.
 */
export async function queryAuditLogs(
  filter: AuditExportFilter = {}
): Promise<CsvRow[]> {
  const { dbCtx } = await import("./_core/dbCtx");
  const { db, schema, and, gte, lte, desc } = await dbCtx();
  if (!db) return [];
  const { accessLogs } = schema;
  const conditions = [];
  if (filter.from) conditions.push(gte(accessLogs.createdAt, filter.from));
  if (filter.to) conditions.push(lte(accessLogs.createdAt, filter.to));
  const limit = Math.min(
    Math.max(1, filter.limit ?? AUDIT_EXPORT_MAX),
    AUDIT_EXPORT_MAX
  );
  const base = db
    .select({
      id: accessLogs.id,
      userId: accessLogs.userId,
      action: accessLogs.action,
      studyId: accessLogs.studyId,
      detail: accessLogs.detail,
      ipAddress: accessLogs.ipAddress,
      createdAt: accessLogs.createdAt,
    })
    .from(accessLogs)
    .orderBy(desc(accessLogs.createdAt))
    .limit(limit);
  if (conditions.length > 0) {
    return base.where(and(...conditions));
  }
  return base;
}

/**
 * Delete access_logs rows older than `olderThanDays` days. Returns the number
 * of rows deleted. Refuses windows below MIN_RETENTION_DAYS (fail-safe).
 *
 * NOTE: this could be extended to purge studies/series/instances (and their
 * stored DICOM objects) past a clinical retention window — but that erases PHI
 * permanently, so it must reuse studies.delete's storage-cleanup path and be a
 * separate, explicitly-confirmed admin action. Not implemented here.
 */
export async function purgeAuditLogs(olderThanDays: number): Promise<number> {
  if (olderThanDays < MIN_RETENTION_DAYS) {
    throw new Error(
      `Rétention trop courte : minimum ${MIN_RETENTION_DAYS} jours.`
    );
  }
  const { dbCtx } = await import("./_core/dbCtx");
  const { db, schema, lt } = await dbCtx();
  if (!db) return 0;
  const { accessLogs } = schema;
  const cutoff = cutoffDate(new Date(), olderThanDays);
  const result: any = await db
    .delete(accessLogs)
    .where(lt(accessLogs.createdAt, cutoff));
  // mysql2 returns [{ affectedRows }]; be defensive across driver shapes.
  return (
    result?.[0]?.affectedRows ??
    result?.affectedRows ??
    result?.rowsAffected ??
    0
  );
}
