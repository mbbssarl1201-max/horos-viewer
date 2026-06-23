import {
  eq,
  desc,
  and,
  like,
  sql,
  gte,
  lt,
  ne,
  asc,
  inArray,
  isNull,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  patients,
  studies,
  series,
  instances,
  albums,
  albumStudies,
  notifications,
  annotations,
  accessLogs,
  reports,
  reportAddenda,
  aiEvaluations,
  aiJobs,
  referringContacts,
  agentSettings,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import {
  encryptField,
  encryptDeterministic,
  decryptField,
} from "./_core/crypto";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============ USER QUERIES ============

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    await db
      .insert(users)
      .values(values)
      .onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] || undefined;
}

export async function countUsers(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.select({ count: sql<number>`COUNT(*)` }).from(users);
  return result[0]?.count ?? 0;
}

/**
 * Create a user for self-hosted email/password auth. Returns the created row.
 * Throws if the DB is unavailable.
 */
export async function createLocalUser(input: {
  openId: string;
  email: string;
  name: string | null;
  passwordHash: string;
  role: "user" | "admin" | "radiologist" | "technician";
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(users).values({
    openId: input.openId,
    email: input.email,
    name: input.name,
    passwordHash: input.passwordHash,
    role: input.role,
    loginMethod: "local",
    lastSignedIn: new Date(),
  });
  return getUserByOpenId(input.openId);
}

/**
 * Increment a user's session version, invalidating every JWT issued before
 * now. Called on logout to make session revocation server-side and immediate.
 */
export async function bumpSessionVersion(openId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.openId, openId));
}

// ============ STUDY QUERIES ============

export async function listStudies(filters?: {
  modality?: string;
  search?: string;
  timeFilter?: string;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters?.modality) {
    conditions.push(eq(studies.modality, filters.modality));
  }
  if (filters?.timeFilter && filters.timeFilter !== "none") {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    switch (filters.timeFilter) {
      case "today":
        conditions.push(gte(studies.createdAt, todayStart));
        break;
      case "yesterday": {
        const yesterdayStart = new Date(
          todayStart.getTime() - 24 * 60 * 60 * 1000
        );
        conditions.push(gte(studies.createdAt, yesterdayStart));
        conditions.push(sql`${studies.createdAt} < ${todayStart}`);
        break;
      }
      case "last_week":
        conditions.push(
          gte(
            studies.createdAt,
            new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          )
        );
        break;
      case "last_month":
        conditions.push(
          gte(
            studies.createdAt,
            new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          )
        );
        break;
      case "last_year":
        conditions.push(
          gte(
            studies.createdAt,
            new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
          )
        );
        break;
    }
  }

  const query = db
    .select({
      id: studies.id,
      patientName: patients.patientName,
      patientDicomId: patients.patientId,
      birthDate: patients.birthDate,
      studyInstanceUid: studies.studyInstanceUid,
      studyDate: studies.studyDate,
      studyDescription: studies.studyDescription,
      modality: studies.modality,
      accessionNumber: studies.accessionNumber,
      referringPhysician: studies.referringPhysician,
      performingPhysician: studies.performingPhysician,
      institution: studies.institution,
      numberOfSeries: studies.numberOfSeries,
      numberOfInstances: studies.numberOfInstances,
      priority: studies.priority,
      status: studies.status,
      createdAt: studies.createdAt,
    })
    .from(studies)
    .leftJoin(patients, eq(studies.patientId, patients.id))
    .orderBy(desc(studies.createdAt));

  const rows =
    conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  // Déchiffrement des identités patient (chiffrées au repos, nLPD).
  return rows.map(r => ({
    ...r,
    patientName: decryptField(r.patientName),
    patientDicomId: decryptField(r.patientDicomId),
    birthDate: decryptField(r.birthDate),
  }));
}

export async function getStudyById(studyId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select({
      id: studies.id,
      patientName: patients.patientName,
      birthDate: patients.birthDate,
      patientId: patients.patientId,
      // FK interne patients.id : vérité de comparaison patient pour la garde
      // anti-IDOR antériorité (assertSamePatientStudies).
      patientFk: studies.patientId,
      studyInstanceUid: studies.studyInstanceUid,
      studyDate: studies.studyDate,
      studyDescription: studies.studyDescription,
      modality: studies.modality,
      referringPhysician: studies.referringPhysician,
      performingPhysician: studies.performingPhysician,
      institution: studies.institution,
      numberOfSeries: studies.numberOfSeries,
      numberOfInstances: studies.numberOfInstances,
      priority: studies.priority,
      status: studies.status,
    })
    .from(studies)
    .leftJoin(patients, eq(studies.patientId, patients.id))
    .where(eq(studies.id, studyId))
    .limit(1);
  const row = result[0];
  if (!row) return undefined;
  return {
    ...row,
    patientName: decryptField(row.patientName),
    patientId: decryptField(row.patientId),
    birthDate: decryptField(row.birthDate),
  };
}

/**
 * Liste les AUTRES études du même patient (antécédents d'imagerie), hors étude
 * courante, les plus récentes d'abord. Le patient est résolu via le patientId
 * (FK int) de l'étude courante.
 */
export async function listPriorStudiesForStudy(studyId: number) {
  const db = await getDb();
  if (!db) return [];
  const cur = await db
    .select({ patientFk: studies.patientId })
    .from(studies)
    .where(eq(studies.id, studyId))
    .limit(1);
  const patientFk = cur[0]?.patientFk;
  if (patientFk == null) return [];
  return db
    .select({
      id: studies.id,
      studyDate: studies.studyDate,
      modality: studies.modality,
      studyDescription: studies.studyDescription,
    })
    .from(studies)
    .where(and(eq(studies.patientId, patientFk), ne(studies.id, studyId)))
    .orderBy(desc(studies.studyDate));
}

// ============ SERIES QUERIES ============

export async function listSeriesByStudy(studyId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(series)
    .where(eq(series.studyId, studyId))
    .orderBy(series.seriesNumber);
}

// ============ INSTANCE QUERIES ============

export async function listInstancesBySeries(seriesId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(instances)
    .where(eq(instances.seriesId, seriesId))
    .orderBy(instances.instanceNumber);
}

// ============ PATIENT QUERIES ============

export async function findOrCreatePatient(patientData: {
  patientId: string;
  patientName: string;
  birthDate?: string;
  sex?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // patientId chiffré DÉTERMINISTE : la dédup par égalité fonctionne toujours
  // sur l'index, mais la valeur stockée est chiffrée au repos (nLPD).
  const encPatientId = encryptDeterministic(patientData.patientId)!;

  const decryptRow = (p: typeof patients.$inferSelect) => ({
    ...p,
    patientId: decryptField(p.patientId),
    patientName: decryptField(p.patientName),
    birthDate: decryptField(p.birthDate),
    sex: decryptField(p.sex),
  });

  const existing = await db
    .select()
    .from(patients)
    .where(eq(patients.patientId, encPatientId))
    .limit(1);

  if (existing.length > 0) return decryptRow(existing[0]);

  await db.insert(patients).values({
    patientId: encPatientId,
    patientName: encryptField(patientData.patientName)!,
    birthDate: encryptField(patientData.birthDate || null),
    sex: encryptField(patientData.sex || null),
  });

  const newPatient = await db
    .select()
    .from(patients)
    .where(eq(patients.patientId, encPatientId))
    .limit(1);
  return decryptRow(newPatient[0]);
}

// ============ DICOM IMPORT ============

export async function createStudy(data: {
  patientId: number;
  studyInstanceUid: string;
  studyDate?: string;
  studyTime?: string;
  studyDescription?: string;
  accessionNumber?: string;
  referringPhysician?: string;
  performingPhysician?: string;
  institution?: string;
  modality?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check if study already exists
  const existing = await db
    .select()
    .from(studies)
    .where(eq(studies.studyInstanceUid, data.studyInstanceUid))
    .limit(1);

  if (existing.length > 0) return existing[0];

  await db.insert(studies).values(data);

  const newStudy = await db
    .select()
    .from(studies)
    .where(eq(studies.studyInstanceUid, data.studyInstanceUid))
    .limit(1);
  return newStudy[0];
}

export async function createSeries(data: {
  studyId: number;
  seriesInstanceUid: string;
  seriesNumber?: number;
  seriesDescription?: string;
  modality?: string;
  bodyPart?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select()
    .from(series)
    .where(eq(series.seriesInstanceUid, data.seriesInstanceUid))
    .limit(1);

  if (existing.length > 0) return existing[0];

  await db.insert(series).values(data);

  const newSeries = await db
    .select()
    .from(series)
    .where(eq(series.seriesInstanceUid, data.seriesInstanceUid))
    .limit(1);
  return newSeries[0];
}

export async function createInstance(data: {
  seriesId: number;
  sopInstanceUid: string;
  instanceNumber?: number;
  storageKey: string;
  storageUrl?: string;
  rows?: number;
  columns?: number;
  bitsAllocated?: number;
  windowCenter?: string;
  windowWidth?: string;
  fileSize?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select()
    .from(instances)
    .where(eq(instances.sopInstanceUid, data.sopInstanceUid))
    .limit(1);

  if (existing.length > 0) return existing[0];

  await db.insert(instances).values(data);

  const newInstance = await db
    .select()
    .from(instances)
    .where(eq(instances.sopInstanceUid, data.sopInstanceUid))
    .limit(1);
  return newInstance[0];
}

// ============ NOTIFICATIONS ============

export async function createNotification(data: {
  userId: number;
  type: "new_study" | "stat_urgent" | "report_finalized" | "shared_study";
  title: string;
  message?: string;
  studyId?: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(notifications).values(data);
}

export async function getUserNotifications(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
}

/**
 * Liste les comptes cliniques (admin/radiologist/technician) hors l'appelant,
 * pour le partage interne d'étude. PHI-safe : pas de hash de mot de passe.
 */
export async function listClinicalUsers(excludeUserId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(
      and(
        inArray(users.role, ["admin", "radiologist", "technician"]),
        ne(users.id, excludeUserId)
      )
    );
}

export async function markNotificationRead(
  notificationId: number,
  userId: number
) {
  const db = await getDb();
  if (!db) return;
  // Scope by userId so a user can only mark their own notifications as read.
  await db
    .update(notifications)
    .set({ isRead: 1 })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      )
    );
}

// ============ UPDATE COUNTS ============

export async function updateStudyCounts(studyId: number) {
  const db = await getDb();
  if (!db) return;

  const seriesCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(series)
    .where(eq(series.studyId, studyId));

  const instanceCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(instances)
    .innerJoin(series, eq(instances.seriesId, series.id))
    .where(eq(series.studyId, studyId));

  await db
    .update(studies)
    .set({
      numberOfSeries: seriesCount[0]?.count || 0,
      numberOfInstances: instanceCount[0]?.count || 0,
    })
    .where(eq(studies.id, studyId));
}

export async function updateSeriesCount(seriesId: number) {
  const db = await getDb();
  if (!db) return;

  const count = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(instances)
    .where(eq(instances.seriesId, seriesId));

  await db
    .update(series)
    .set({ numberOfInstances: count[0]?.count || 0 })
    .where(eq(series.id, seriesId));
}

// ============ ACCESS LOG (HIPAA / nLPD audit trail) ============

/** Count a user's recent access events of a given action (for rate limiting). */
export async function countRecentAccess(
  userId: number,
  action: string,
  withinMinutes: number
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(accessLogs)
    .where(
      and(
        eq(accessLogs.userId, userId),
        eq(accessLogs.action, action),
        gte(accessLogs.createdAt, sql`NOW() - INTERVAL ${withinMinutes} MINUTE`)
      )
    );
  return rows[0]?.count ?? 0;
}

export interface AccessEvent {
  userId: number;
  action: string;
  studyId?: number | null;
  detail?: string | null;
  ipAddress?: string | null;
}

/**
 * Append one PHI-access record. Best-effort: a logging failure is recorded to
 * the console but never propagated, so audit problems can't break a clinical
 * request mid-flight. (If a hard "no audit, no access" policy is required, make
 * the callers await and fail on rejection instead.)
 */
export async function recordAccess(event: AccessEvent): Promise<void> {
  try {
    const db = await getDb();
    if (!db) {
      console.warn(
        "[AccessLog] DB unavailable, access NOT recorded:",
        event.action
      );
      return;
    }
    await db.insert(accessLogs).values({
      userId: event.userId,
      action: event.action,
      studyId: event.studyId ?? null,
      detail: event.detail ?? null,
      ipAddress: event.ipAddress ?? null,
    });
  } catch (err) {
    console.error(
      "[AccessLog] Failed to record access event:",
      event.action,
      err
    );
  }
}

// ============ REPORT QUERIES ============

export async function getReportByStudy(studyId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.studyId, studyId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getReportAddenda(reportId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(reportAddenda)
    .where(eq(reportAddenda.reportId, reportId))
    .orderBy(asc(reportAddenda.createdAt));
}

// --- Mode validation IA -----------------------------------------------------

/** Snapshot du brouillon IA pour une étude (à la pré-analyse). Conserve le
 *  verdict déjà saisi s'il existe (on ne ré-évalue pas en ré-analysant). */
export async function snapshotAiEvaluation(data: {
  studyId: number;
  userId: number;
  model?: string | null;
  modality?: string | null;
  aiAbnormal?: boolean | null;
  aiConclusion?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(aiEvaluations)
    .values({
      studyId: data.studyId,
      userId: data.userId,
      model: data.model ?? null,
      modality: data.modality ?? null,
      aiAbnormal: data.aiAbnormal ?? null,
      aiConclusion: data.aiConclusion ?? null,
    })
    .onDuplicateKeyUpdate({
      set: {
        userId: data.userId,
        model: data.model ?? null,
        modality: data.modality ?? null,
        aiAbnormal: data.aiAbnormal ?? null,
        aiConclusion: data.aiConclusion ?? null,
      },
    });
}

/** Verdict du médecin sur le brouillon IA d'une étude. */
export async function recordAiVerdict(data: {
  studyId: number;
  verdict: "juste" | "partielle" | "fausse";
  missedFinding: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(aiEvaluations)
    .set({
      verdict: data.verdict,
      missedFinding: data.missedFinding,
      evaluatedAt: sql`now()`,
    })
    .where(eq(aiEvaluations.studyId, data.studyId));
}

/** Verdict déjà saisi pour une étude (ou null). */
export async function getAiEvaluation(studyId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(aiEvaluations)
    .where(eq(aiEvaluations.studyId, studyId))
    .limit(1);
  return rows[0] ?? null;
}

/** Statistiques d'accord IA (sur les évaluations renseignées). */
export async function getAiEvaluationStats() {
  const db = await getDb();
  if (!db) return { total: 0, juste: 0, partielle: 0, fausse: 0, missed: 0 };
  const rows: { verdict: string | null; missed: boolean }[] = await db
    .select({
      verdict: aiEvaluations.verdict,
      missed: aiEvaluations.missedFinding,
    })
    .from(aiEvaluations);
  const evaluated = rows.filter(r => r.verdict != null);
  const count = (v: string) => evaluated.filter(r => r.verdict === v).length;
  return {
    total: evaluated.length,
    juste: count("juste"),
    partielle: count("partielle"),
    fausse: count("fausse"),
    missed: evaluated.filter(r => r.missed).length,
  };
}

// ============ AI EXHAUSTIVE JOBS (persistés, survivent au redémarrage) ============

export interface AiJobState {
  status: "running" | "done" | "error";
  progress: { done: number; total: number };
  result?: unknown;
  error?: string;
}

export async function createAiJob(id: string, studyId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(aiJobs).values({ id, studyId, status: "running" });
  } catch (e) {
    console.warn("[AiJob] create failed:", e);
  }
}

export async function updateAiJobProgress(
  id: string,
  done: number,
  total: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db
      .update(aiJobs)
      .set({ progressDone: done, progressTotal: total, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  } catch {
    /* best-effort */
  }
}

export async function finishAiJob(id: string, result: unknown): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db
      .update(aiJobs)
      .set({ status: "done", result: result as any, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  } catch (e) {
    console.warn("[AiJob] finish failed:", e);
  }
}

export async function failAiJob(id: string, error: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db
      .update(aiJobs)
      .set({
        status: "error",
        error: error.slice(0, 512),
        updatedAt: new Date(),
      })
      .where(eq(aiJobs.id, id));
  } catch {
    /* best-effort */
  }
}

export async function getAiJob(id: string): Promise<AiJobState | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      status: r.status,
      progress: { done: r.progressDone, total: r.progressTotal },
      result: r.result ?? undefined,
      error: r.error ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Au boot : tout job resté « running » provient d'un crash/redémarrage (le
 * calcul en mémoire est perdu) → on le marque « error » pour que le client
 * affiche « interrompu, relancez » au lieu d'un avancement figé.
 * Purge aussi les jobs de plus de 24 h (évite l'accumulation).
 */
export async function recoverStaleAiJobs(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  try {
    await db
      .update(aiJobs)
      .set({
        status: "error",
        error: "Analyse interrompue par un redémarrage du serveur — relancez.",
        updatedAt: new Date(),
      })
      .where(eq(aiJobs.status, "running"));
    const cutoff = new Date(Date.now() - 24 * 3600_000);
    await db.delete(aiJobs).where(lt(aiJobs.createdAt, cutoff));
    return 1;
  } catch (e) {
    console.warn("[AiJob] recover failed:", e);
    return 0;
  }
}

// ============ AGENT CR AUTONOME ============

/** Normalise un nom de référent pour servir de clé de correspondance e-mail. */
export function normalizeReferringName(name?: string | null): string {
  if (!name) return "";
  return name
    .replace(/\^/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function getAgentSettings() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateAgentSettings(patch: {
  enabled?: boolean;
  dailyCap?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const current = await getAgentSettings();
  const enabledAt =
    patch.enabled && !current?.enabledAt
      ? new Date()
      : (current?.enabledAt ?? null);
  await db
    .update(agentSettings)
    .set({
      enabled: patch.enabled ?? current?.enabled ?? false,
      dailyCap: patch.dailyCap ?? current?.dailyCap ?? 20,
      enabledAt,
      updatedAt: new Date(),
    })
    .where(eq(agentSettings.id, 1));
}

export async function setAgentLastRun(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(agentSettings)
    .set({ lastRunAt: new Date() })
    .where(eq(agentSettings.id, 1));
}

/** Études SANS report, créées après `since`, limitées à `limit`. */
export async function findStudyIdsNeedingReport(
  since: Date,
  limit: number
): Promise<number[]> {
  const db = await getDb();
  if (!db || limit <= 0) return [];
  const rows = await db
    .select({ id: studies.id })
    .from(studies)
    .leftJoin(reports, eq(reports.studyId, studies.id))
    .where(and(isNull(reports.id), gte(studies.createdAt, since)))
    .orderBy(asc(studies.id))
    .limit(limit);
  return rows.map(r => r.id);
}

/** Nombre de reports IA créés depuis `since` (plafond/jour). */
export async function countAiReportsSince(since: Date): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(reports)
    .where(and(eq(reports.aiGenerated, true), gte(reports.createdAt, since)));
  return Number(rows[0]?.n ?? 0);
}

export async function resolveReferringEmail(
  name?: string | null
): Promise<string | null> {
  const key = normalizeReferringName(name);
  if (!key) return null;
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(referringContacts)
    .where(eq(referringContacts.name, key))
    .limit(1);
  return rows[0]?.email ?? null;
}

export async function upsertReferringEmail(
  name: string,
  email: string
): Promise<void> {
  const key = normalizeReferringName(name);
  if (!key) return;
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select()
    .from(referringContacts)
    .where(eq(referringContacts.name, key))
    .limit(1);
  if (existing[0]) {
    await db
      .update(referringContacts)
      .set({ email, updatedAt: new Date() })
      .where(eq(referringContacts.id, existing[0].id));
  } else {
    await db.insert(referringContacts).values({ name: key, email });
  }
}
