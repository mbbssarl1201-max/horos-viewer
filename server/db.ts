import { eq, desc, and, like, sql, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, patients, studies, series, instances, albums, albumStudies, notifications, annotations, accessLogs } from "../drizzle/schema";
import { ENV } from './_core/env';

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
      values.role = 'admin';
      updateSet.role = 'admin';
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============ STUDY QUERIES ============

export async function listStudies(filters?: { modality?: string; search?: string; timeFilter?: string }) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters?.modality) {
    conditions.push(eq(studies.modality, filters.modality));
  }
  if (filters?.timeFilter && filters.timeFilter !== "none") {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (filters.timeFilter) {
      case "today":
        conditions.push(gte(studies.createdAt, todayStart));
        break;
      case "yesterday": {
        const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
        conditions.push(gte(studies.createdAt, yesterdayStart));
        conditions.push(sql`${studies.createdAt} < ${todayStart}`);
        break;
      }
      case "last_week":
        conditions.push(gte(studies.createdAt, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)));
        break;
      case "last_month":
        conditions.push(gte(studies.createdAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)));
        break;
      case "last_year":
        conditions.push(gte(studies.createdAt, new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)));
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

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
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
  return result[0] || undefined;
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

  const existing = await db
    .select()
    .from(patients)
    .where(eq(patients.patientId, patientData.patientId))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const result = await db.insert(patients).values({
    patientId: patientData.patientId,
    patientName: patientData.patientName,
    birthDate: patientData.birthDate || null,
    sex: patientData.sex || null,
  });

  const newPatient = await db
    .select()
    .from(patients)
    .where(eq(patients.patientId, patientData.patientId))
    .limit(1);
  return newPatient[0];
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
  type: "new_study" | "stat_urgent" | "report_finalized";
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

export async function markNotificationRead(notificationId: number, userId: number) {
  const db = await getDb();
  if (!db) return;
  // Scope by userId so a user can only mark their own notifications as read.
  await db
    .update(notifications)
    .set({ isRead: 1 })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
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
      console.warn("[AccessLog] DB unavailable, access NOT recorded:", event.action);
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
    console.error("[AccessLog] Failed to record access event:", event.action, err);
  }
}
