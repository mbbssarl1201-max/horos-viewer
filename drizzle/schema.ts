import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  bigint,
  json,
  index,
  boolean,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Roles: admin, radiologist, technician
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  // bcrypt hash for self-hosted email/password auth. Null for OAuth users.
  passwordHash: varchar("passwordHash", { length: 255 }),
  role: mysqlEnum("role", ["user", "admin", "radiologist", "technician"])
    .default("user")
    .notNull(),
  // Bumped on logout to revoke every previously issued session JWT for this
  // user. A token whose `sv` claim != this value is rejected at auth time.
  sessionVersion: int("sessionVersion").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/**
 * DICOM Patient table
 */
export const patients = mysqlTable(
  "patients",
  {
    id: int("id").autoincrement().primaryKey(),
    // Longueurs élargies : ces champs sont chiffrés au repos (nLPD) et le
    // chiffré (base64 de IV+tag+ciphertext) est plus long que le clair.
    patientId: varchar("patientId", { length: 512 }).notNull(),
    patientName: varchar("patientName", { length: 1024 }).notNull(),
    birthDate: varchar("birthDate", { length: 128 }),
    sex: varchar("sex", { length: 64 }),
    // Blind index : empreinte DÉTERMINISTE du nom normalisé → recherche par nom
    // sans déchiffrer toute la base (le nom reste chiffré dans patientName).
    nameSearch: varchar("nameSearch", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    patientIdIdx: index("patients_patientId_idx").on(t.patientId),
    nameSearchIdx: index("patients_nameSearch_idx").on(t.nameSearch),
  })
);

/**
 * DICOM Study table
 */
export const studies = mysqlTable(
  "studies",
  {
    id: int("id").autoincrement().primaryKey(),
    patientId: int("patientId").notNull(),
    studyInstanceUid: varchar("studyInstanceUid", { length: 128 })
      .notNull()
      .unique(),
    studyDate: varchar("studyDate", { length: 10 }),
    studyTime: varchar("studyTime", { length: 16 }),
    studyDescription: text("studyDescription"),
    accessionNumber: varchar("accessionNumber", { length: 64 }),
    referringPhysician: varchar("referringPhysician", { length: 256 }),
    performingPhysician: varchar("performingPhysician", { length: 256 }),
    institution: varchar("institution", { length: 256 }),
    modality: varchar("modality", { length: 16 }),
    numberOfSeries: int("numberOfSeries").default(0),
    numberOfInstances: int("numberOfInstances").default(0),
    priority: mysqlEnum("priority", ["routine", "stat", "urgent"]).default(
      "routine"
    ),
    status: mysqlEnum("status", [
      "new",
      "in_progress",
      "reported",
      "finalized",
    ]).default("new"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    patientIdIdx: index("studies_patientId_idx").on(t.patientId),
    createdAtIdx: index("studies_createdAt_idx").on(t.createdAt),
  })
);

/**
 * DICOM Series table
 */
export const series = mysqlTable(
  "series",
  {
    id: int("id").autoincrement().primaryKey(),
    studyId: int("studyId").notNull(),
    seriesInstanceUid: varchar("seriesInstanceUid", { length: 128 })
      .notNull()
      .unique(),
    seriesNumber: int("seriesNumber"),
    seriesDescription: text("seriesDescription"),
    modality: varchar("modality", { length: 16 }),
    bodyPart: varchar("bodyPart", { length: 64 }),
    numberOfInstances: int("numberOfInstances").default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    studyIdIdx: index("series_studyId_idx").on(t.studyId),
  })
);

/**
 * DICOM Instance (image) table
 */
export const instances = mysqlTable(
  "instances",
  {
    id: int("id").autoincrement().primaryKey(),
    seriesId: int("seriesId").notNull(),
    sopInstanceUid: varchar("sopInstanceUid", { length: 128 })
      .notNull()
      .unique(),
    instanceNumber: int("instanceNumber"),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    storageUrl: varchar("storageUrl", { length: 1024 }),
    rows: int("rows"),
    columns: int("columns"),
    bitsAllocated: int("bitsAllocated"),
    windowCenter: varchar("windowCenter", { length: 64 }),
    windowWidth: varchar("windowWidth", { length: 64 }),
    fileSize: bigint("fileSize", { mode: "number" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    seriesIdIdx: index("instances_seriesId_idx").on(t.seriesId),
  })
);

/**
 * Albums for organizing studies
 */
export const albums = mysqlTable(
  "albums",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description"),
    userId: int("userId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    userIdIdx: index("albums_userId_idx").on(t.userId),
  })
);

/**
 * Album-Study junction table
 */
export const albumStudies = mysqlTable(
  "album_studies",
  {
    id: int("id").autoincrement().primaryKey(),
    albumId: int("albumId").notNull(),
    studyId: int("studyId").notNull(),
    addedAt: timestamp("addedAt").defaultNow().notNull(),
  },
  t => ({
    albumIdIdx: index("album_studies_albumId_idx").on(t.albumId),
    studyIdIdx: index("album_studies_studyId_idx").on(t.studyId),
  })
);

/**
 * Notifications table
 */
export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    type: mysqlEnum("type", [
      "new_study",
      "stat_urgent",
      "report_finalized",
      "shared_study",
    ]).notNull(),
    title: varchar("title", { length: 256 }).notNull(),
    message: text("message"),
    studyId: int("studyId"),
    isRead: int("isRead").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    userIdIdx: index("notifications_userId_idx").on(t.userId),
    studyIdIdx: index("notifications_studyId_idx").on(t.studyId),
  })
);

/**
 * Annotations table for measurements and ROIs
 */
export const annotations = mysqlTable(
  "annotations",
  {
    id: int("id").autoincrement().primaryKey(),
    instanceId: int("instanceId").notNull(),
    userId: int("userId").notNull(),
    type: mysqlEnum("type", [
      "length",
      "angle",
      "rect_roi",
      "ellipse_roi",
      "text",
    ]).notNull(),
    data: json("data").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    instanceIdIdx: index("annotations_instanceId_idx").on(t.instanceId),
    userIdIdx: index("annotations_userId_idx").on(t.userId),
  })
);

/**
 * PACS Server sources (configurable)
 */
export const pacsServers = mysqlTable(
  "pacs_servers",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    aeTitle: varchar("aeTitle", { length: 64 }).notNull(),
    host: varchar("host", { length: 256 }).notNull(),
    port: int("port").notNull().default(4242),
    orthancUrl: varchar("orthancUrl", { length: 512 }),
    isDefault: int("isDefault").default(0).notNull(),
    userId: int("userId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    userIdIdx: index("pacs_servers_userId_idx").on(t.userId),
  })
);

/**
 * PHI access audit trail (HIPAA / nLPD). One row per access to patient data:
 * who (userId), what (action), which study, when, and from where (IP).
 * Append-only — never updated or deleted in normal operation.
 */
export const accessLogs = mysqlTable(
  "access_logs",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    studyId: int("studyId"),
    detail: varchar("detail", { length: 256 }),
    ipAddress: varchar("ipAddress", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    userIdIdx: index("access_logs_userId_idx").on(t.userId),
    studyIdIdx: index("access_logs_studyId_idx").on(t.studyId),
    createdAtIdx: index("access_logs_createdAt_idx").on(t.createdAt),
  })
);

/**
 * Compte-rendu radiologique : un par étude (studyId unique). Cycle draft→signed.
 * Une fois signé, immuable (verrou applicatif côté routeur reports) ; les
 * corrections passent par reportAddenda.
 */
export const reports = mysqlTable("reports", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull().unique(),
  status: mysqlEnum("status", ["draft", "signed"]).default("draft").notNull(),
  indication: text("indication"),
  technique: text("technique"),
  resultats: text("resultats"),
  conclusion: text("conclusion"),
  aiGenerated: boolean("aiGenerated").default(false).notNull(),
  aiModel: varchar("aiModel", { length: 128 }),
  createdBy: int("createdBy").notNull(),
  signedBy: int("signedBy"),
  signedAt: timestamp("signedAt"),
  pdfStorageKey: varchar("pdfStorageKey", { length: 512 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Addenda (corrections post-signature), append-only, datés. */
export const reportAddenda = mysqlTable("report_addenda", {
  id: int("id").autoincrement().primaryKey(),
  reportId: int("reportId").notNull(),
  text: text("text").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Patient = typeof patients.$inferSelect;
export type Study = typeof studies.$inferSelect;
export type Series = typeof series.$inferSelect;
export type Instance = typeof instances.$inferSelect;
export type Album = typeof albums.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
export type AccessLog = typeof accessLogs.$inferSelect;
export type InsertAccessLog = typeof accessLogs.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type InsertReport = typeof reports.$inferInsert;
export type ReportAddendum = typeof reportAddenda.$inferSelect;
export type InsertReportAddendum = typeof reportAddenda.$inferInsert;

// Base de connaissances RAG d'Hermès (NON-PHI). `embedding` = JSON.stringify(number[]).
export const knowledgeChunks = mysqlTable("knowledge_chunks", {
  id: int("id").autoincrement().primaryKey(),
  source: varchar("source", { length: 512 }).notNull(),
  heading: varchar("heading", { length: 512 }),
  content: text("content").notNull(),
  embedding: text("embedding").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Mode validation IA : snapshot du brouillon de pré-analyse par étude + verdict
// du médecin (la lecture humaine = vérité). Permet de mesurer, sur les vrais
// examens, le taux d'accord de l'IA vision. Non-PHI sensible (pas de pixels).
export const aiEvaluations = mysqlTable("ai_evaluations", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull().unique(),
  userId: int("userId").notNull(),
  model: varchar("model", { length: 128 }),
  modality: varchar("modality", { length: 16 }),
  aiAbnormal: boolean("aiAbnormal"),
  aiConclusion: text("aiConclusion"),
  // Verdict du médecin sur le brouillon IA (null tant que non évalué).
  verdict: mysqlEnum("verdict", ["juste", "partielle", "fausse"]),
  // L'IA a-t-elle MANQUÉ une anomalie réelle ? (sécurité clinique)
  missedFinding: boolean("missedFinding").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  evaluatedAt: timestamp("evaluatedAt"),
});
export type AiEvaluation = typeof aiEvaluations.$inferSelect;
export type InsertAiEvaluation = typeof aiEvaluations.$inferInsert;

/**
 * Jobs d'analyse EXHAUSTIVE (tâche de fond, longue).
 * Persistés en base pour SURVIVRE à un redémarrage : au boot, tout job resté
 * « running » est marqué « error » (interrompu) → le client voit « relancez »
 * au lieu d'un « 0/N » figé ou d'un « Job inconnu ». (Pas de reprise auto.)
 */
export const aiJobs = mysqlTable(
  "ai_jobs",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    studyId: int("studyId").notNull(),
    status: mysqlEnum("status", ["running", "done", "error"])
      .notNull()
      .default("running"),
    progressDone: int("progressDone").notNull().default(0),
    progressTotal: int("progressTotal").notNull().default(0),
    result: json("result"),
    error: varchar("error", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  t => ({ studyIdx: index("ai_jobs_study_idx").on(t.studyId) })
);
export type AiJob = typeof aiJobs.$inferSelect;
export type InsertAiJob = typeof aiJobs.$inferInsert;

/** Correspondance nom de médecin référent → e-mail (mono-cabinet). */
export const referringContacts = mysqlTable(
  "referring_contacts",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 256 }).notNull(),
    email: varchar("email", { length: 256 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  t => ({ nameIdx: index("referring_contacts_name_idx").on(t.name) })
);
export type ReferringContact = typeof referringContacts.$inferSelect;

/** Réglages de l'agent CR autonome. Ligne UNIQUE (id=1). */
export const agentSettings = mysqlTable("agent_settings", {
  id: int("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  enabledAt: timestamp("enabledAt"),
  dailyCap: int("dailyCap").notNull().default(20),
  lastRunAt: timestamp("lastRunAt"),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type AgentSettings = typeof agentSettings.$inferSelect;

/** État + réglages par agent Hermès (registre des fiches = code). */
export const agentState = mysqlTable("agent_state", {
  agentKey: varchar("agentKey", { length: 64 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  targetsJson: text("targetsJson"),
  lastRunAt: timestamp("lastRunAt"),
  lastError: varchar("lastError", { length: 512 }),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type AgentState = typeof agentState.$inferSelect;

/** Journal d'activité par agent (santé + audit). */
export const agentActivity = mysqlTable(
  "agent_activity",
  {
    id: int("id").autoincrement().primaryKey(),
    agentKey: varchar("agentKey", { length: 64 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    studyId: int("studyId"),
    status: mysqlEnum("status", ["ok", "error", "skipped"]).notNull(),
    detail: varchar("detail", { length: 512 }),
    durationMs: int("durationMs"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({ agentIdx: index("agent_activity_agent_idx").on(t.agentKey) })
);
export type AgentActivity = typeof agentActivity.$inferSelect;

/** Mémoire d'agent : notes courtes d'amélioration. */
export const agentNotes = mysqlTable("agent_notes", {
  id: int("id").autoincrement().primaryKey(),
  agentKey: varchar("agentKey", { length: 64 }).notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentNote = typeof agentNotes.$inferSelect;

/** Suggestions d'auto-amélioration (proposées → validées par le gérant). */
export const agentSuggestions = mysqlTable("agent_suggestions", {
  id: int("id").autoincrement().primaryKey(),
  agentKey: varchar("agentKey", { length: 64 }).notNull(),
  kpiKey: varchar("kpiKey", { length: 64 }).notNull(),
  gap: int("gap"),
  suggestion: text("suggestion").notNull(),
  status: mysqlEnum("status", ["open", "approved", "dismissed"])
    .notNull()
    .default("open"),
  kind: mysqlEnum("kind", ["improvement", "rag_fiche"])
    .notNull()
    .default("improvement"),
  modality: varchar("modality", { length: 16 }),
  proposedHeading: varchar("proposedHeading", { length: 512 }),
  proposedContent: text("proposedContent"),
  sampleCount: int("sampleCount"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentSuggestion = typeof agentSuggestions.$inferSelect;

/** Snapshot du brouillon IA à la génération (pour mesurer signé-sans-correction). */
export const reportAiSnapshots = mysqlTable("report_ai_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull().unique(),
  sectionsJson: text("sectionsJson").notNull(),
  model: varchar("model", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ReportAiSnapshot = typeof reportAiSnapshots.$inferSelect;

export const reportShareTokens = mysqlTable(
  "report_share_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    token: varchar("token", { length: 64 }).notNull().unique(),
    reportId: int("reportId").notNull(),
    studyId: int("studyId").notNull(),
    recipientEmail: varchar("recipientEmail", { length: 255 }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  // Aligné sur la migration 0018 (schema.ts = source de vérité unique).
  t => ({
    reportIdIdx: index("report_share_tokens_reportId_idx").on(t.reportId),
    expiresAtIdx: index("report_share_tokens_expiresAt_idx").on(t.expiresAt),
  })
);
export type ReportShareToken = typeof reportShareTokens.$inferSelect;
