import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, bigint, json, index } from "drizzle-orm/mysql-core";

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
  role: mysqlEnum("role", ["user", "admin", "radiologist", "technician"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/**
 * DICOM Patient table
 */
export const patients = mysqlTable("patients", {
  id: int("id").autoincrement().primaryKey(),
  patientId: varchar("patientId", { length: 128 }).notNull(),
  patientName: varchar("patientName", { length: 256 }).notNull(),
  birthDate: varchar("birthDate", { length: 10 }),
  sex: varchar("sex", { length: 2 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  patientIdIdx: index("patients_patientId_idx").on(t.patientId),
}));

/**
 * DICOM Study table
 */
export const studies = mysqlTable("studies", {
  id: int("id").autoincrement().primaryKey(),
  patientId: int("patientId").notNull(),
  studyInstanceUid: varchar("studyInstanceUid", { length: 128 }).notNull().unique(),
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
  priority: mysqlEnum("priority", ["routine", "stat", "urgent"]).default("routine"),
  status: mysqlEnum("status", ["new", "in_progress", "reported", "finalized"]).default("new"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  patientIdIdx: index("studies_patientId_idx").on(t.patientId),
  createdAtIdx: index("studies_createdAt_idx").on(t.createdAt),
}));

/**
 * DICOM Series table
 */
export const series = mysqlTable("series", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull(),
  seriesInstanceUid: varchar("seriesInstanceUid", { length: 128 }).notNull().unique(),
  seriesNumber: int("seriesNumber"),
  seriesDescription: text("seriesDescription"),
  modality: varchar("modality", { length: 16 }),
  bodyPart: varchar("bodyPart", { length: 64 }),
  numberOfInstances: int("numberOfInstances").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  studyIdIdx: index("series_studyId_idx").on(t.studyId),
}));

/**
 * DICOM Instance (image) table
 */
export const instances = mysqlTable("instances", {
  id: int("id").autoincrement().primaryKey(),
  seriesId: int("seriesId").notNull(),
  sopInstanceUid: varchar("sopInstanceUid", { length: 128 }).notNull().unique(),
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
}, (t) => ({
  seriesIdIdx: index("instances_seriesId_idx").on(t.seriesId),
}));

/**
 * Albums for organizing studies
 */
export const albums = mysqlTable("albums", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description"),
  userId: int("userId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userIdIdx: index("albums_userId_idx").on(t.userId),
}));

/**
 * Album-Study junction table
 */
export const albumStudies = mysqlTable("album_studies", {
  id: int("id").autoincrement().primaryKey(),
  albumId: int("albumId").notNull(),
  studyId: int("studyId").notNull(),
  addedAt: timestamp("addedAt").defaultNow().notNull(),
}, (t) => ({
  albumIdIdx: index("album_studies_albumId_idx").on(t.albumId),
  studyIdIdx: index("album_studies_studyId_idx").on(t.studyId),
}));

/**
 * Notifications table
 */
export const notifications = mysqlTable("notifications", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["new_study", "stat_urgent", "report_finalized"]).notNull(),
  title: varchar("title", { length: 256 }).notNull(),
  message: text("message"),
  studyId: int("studyId"),
  isRead: int("isRead").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdIdx: index("notifications_userId_idx").on(t.userId),
  studyIdIdx: index("notifications_studyId_idx").on(t.studyId),
}));

/**
 * Annotations table for measurements and ROIs
 */
export const annotations = mysqlTable("annotations", {
  id: int("id").autoincrement().primaryKey(),
  instanceId: int("instanceId").notNull(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["length", "angle", "rect_roi", "ellipse_roi", "text"]).notNull(),
  data: json("data").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  instanceIdIdx: index("annotations_instanceId_idx").on(t.instanceId),
  userIdIdx: index("annotations_userId_idx").on(t.userId),
}));

/**
 * PACS Server sources (configurable)
 */
export const pacsServers = mysqlTable("pacs_servers", {
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
}, (t) => ({
  userIdIdx: index("pacs_servers_userId_idx").on(t.userId),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Patient = typeof patients.$inferSelect;
export type Study = typeof studies.$inferSelect;
export type Series = typeof series.$inferSelect;
export type Instance = typeof instances.$inferSelect;
export type Album = typeof albums.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
