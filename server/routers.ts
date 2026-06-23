import { COOKIE_NAME, SEVEN_DAYS_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  listStudies,
  getStudyById,
  listSeriesByStudy,
  listInstancesBySeries,
  findOrCreatePatient,
  createStudy,
  createSeries,
  createInstance,
  updateStudyCounts,
  updateSeriesCount,
  getUserNotifications,
  markNotificationRead,
  createNotification,
  recordAccess,
  countRecentAccess,
  getReportByStudy,
  getReportAddenda,
  listClinicalUsers,
} from "./db";
import { buildShareNotification } from "./studyShare";
import { storagePut, storageDelete, storageGetSignedUrl } from "./storage";
import { runAiPreanalysis } from "./report/aiPreanalysis";
import { runHermesChat } from "./report/hermesChat";
import { buildReportPdf } from "./report/reportPdf";
import {
  canSignReport,
  canAddAddendum,
  validateReportSections,
} from "../client/src/lib/reportLifecycle";
import { hasMedicalAccess, isAdmin } from "./rbac";
import {
  checkOrthancConnection,
  qidoSearchStudies,
  cFind,
  cMove,
  cStoreStudy,
  listModalities,
  findWorklist,
} from "./orthanc";
import { parseWorklistAnswers } from "./worklistParse";
import {
  sendEmail,
  notifyNewStudy,
  notifyStatUrgent,
  notifyReportFinalized,
  getSmtpStatus,
} from "./email";
import { ENV } from "./_core/env";
import {
  decryptField,
  encryptField,
  encryptDeterministic,
} from "./_core/crypto";
import { isAllowedRecipient } from "./_core/emailAllowList";
import { shouldNotify, PRIORITY_TRIGGERS, STATUS_TRIGGERS } from "./risNotify";
import { annotationDataSchema } from "./annotationSchema";
import dcmjs from "dcmjs";
import { chunkMarkdown } from "./knowledge/chunk";
import { embedText } from "./knowledge/embeddings";
import {
  insertChunks,
  searchSimilar,
  knowledgeStats,
  clearKnowledge,
} from "./knowledge/store";
import { syncVault, listVaultMarkdown } from "./knowledge/vaultSync";
import { selectRelevant } from "./knowledge/retrieve";

// Garde commune aux endpoints `notifications.notify*` : ils sortent du PHI
// (patientName) vers un destinataire LIBRE. On applique la même allow-list de
// domaines que sendStudyReport et on trace l'egress dans l'audit trail, avant
// tout envoi. Cf. audit C2.
async function guardPhiNotify(
  recipientEmail: string,
  ctx: { user: { id: number }; req?: { ip?: string } }
): Promise<void> {
  if (!isAllowedRecipient(recipientEmail, ENV.reportEmailAllowedDomains))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Destinataire non autorisé (domaine non whitelisté).",
    });
  await recordAccess({
    userId: ctx.user.id,
    action: "study.email.notify",
    studyId: null,
    detail: recipientEmail,
    ipAddress: ctx.req?.ip ?? null,
  });
}

// DICOM Application Entity Title: max 16 chars, no path separators or spaces.
// Constrained here to block path traversal / SSRF when interpolated into the
// Orthanc REST URL (e.g. `/modalities/${aet}/query`).
const aeTitleSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,16}$/, "Invalid AE Title");

// Patient-identifying DICOM tags to remove, keyed as 8-hex-digit
// (group+element) strings — the format dcmjs uses for its dataset dict.
const PII_TAGS = new Set<string>([
  "00100010", // PatientName
  "00100020", // PatientID
  "00100030", // PatientBirthDate
  "00100040", // PatientSex
  "00101000", // OtherPatientIDs
  "00101001", // OtherPatientNames
  "00101010", // PatientAge
  "00101020", // PatientSize
  "00101030", // PatientWeight
  "00101040", // PatientAddress
  "00102154", // PatientTelephoneNumbers
  "00080050", // AccessionNumber
  "00080080", // InstitutionName
  "00080081", // InstitutionAddress
  "00080090", // ReferringPhysicianName
  "00081050", // PerformingPhysicianName
]);

// Recursively blank PII tags in a dcmjs dataset, descending into nested
// sequences (SQ) so PHI hidden in sub-items is removed too.
function scrubDicomDataset(dataset: Record<string, any>): void {
  for (const tag of Object.keys(dataset)) {
    const element = dataset[tag];
    if (!element) continue;
    if (PII_TAGS.has(tag)) {
      element.Value = [];
    } else if (element.vr === "SQ" && Array.isArray(element.Value)) {
      for (const item of element.Value) {
        if (item && typeof item === "object") scrubDicomDataset(item);
      }
    }
  }
}

/**
 * Remove patient-identifying metadata from a DICOM file before storage.
 *
 * Uses dcmjs for real DICOM parsing: it handles both Explicit and Implicit VR
 * transfer syntaxes and nested sequences — cases the previous hand-rolled byte
 * parser mishandled, leaving PHI intact.
 *
 * Fail-closed: if the buffer can't be parsed/anonymized, this THROWS rather
 * than returning the original bytes, so un-anonymized PHI is never stored.
 *
 * NOTE: this removes metadata only. PHI *burned into pixel data* (e.g. US /
 * secondary capture) is NOT handled here and needs separate treatment.
 */
export function anonymizeDicomBuffer(buffer: Buffer): Buffer {
  try {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer, {
      ignoreErrors: true,
    });
    scrubDicomDataset(dicomDict.dict as Record<string, any>);
    const out = dicomDict.write();
    return Buffer.from(out);
  } catch (err) {
    console.error("[Anonymize] DICOM anonymization failed:", err);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "DICOM anonymization failed; file was not stored.",
    });
  }
}

// Clinical read/write access to patient data (PHI). Excludes the default
// "user" role: an account must be promoted to a clinical role first.
const medicalProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!hasMedicalAccess(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical role required",
    });
  }
  return next({ ctx });
});

// Reporting-level actions (admin or radiologist): status, priority, anonymize.
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "radiologist") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin or radiologist access required",
    });
  }
  return next({ ctx });
});

// Destructive / system actions (delete, C-MOVE exfiltration) — admin only.
const strictAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isAdmin(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator access required",
    });
  }
  return next({ ctx });
});

/**
 * Gather everything needed to build an SR/GSPS for a series, with anti-IDOR
 * resolution through the join chain (series → study → patient). Returns null
 * `ctx` (+ a French error) when the series doesn't resolve to a real study, so
 * a forged/foreign seriesId can't produce an object referencing another study.
 */
async function buildSeriesExportContext(seriesId: number): Promise<{
  ctx: import("./dicomDerived").ExportContext | null;
  error?: string;
}> {
  const { getDb } = await import("./db");
  const { series, studies, patients, instances, annotations } = await import(
    "../drizzle/schema"
  );
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return { ctx: null, error: "DB indisponible" };

  // Resolve the series + its parent study + patient in one go.
  const [row] = await db
    .select({
      studyInstanceUid: studies.studyInstanceUid,
      seriesInstanceUid: series.seriesInstanceUid,
      patientName: patients.patientName,
      patientDicomId: patients.patientId,
      birthDate: patients.birthDate,
      sex: patients.sex,
    })
    .from(series)
    .innerJoin(studies, eq(series.studyId, studies.id))
    .leftJoin(patients, eq(studies.patientId, patients.id))
    .where(eq(series.id, seriesId))
    .limit(1);
  if (!row) return { ctx: null, error: "Série introuvable" };
  // Identités patient chiffrées au repos (nLPD) → déchiffrer pour l'usage aval.
  row.patientName = decryptField(row.patientName);
  row.patientDicomId = decryptField(row.patientDicomId);
  row.birthDate = decryptField(row.birthDate);
  row.sex = decryptField(row.sex);

  const seriesInstances = await db
    .select({
      id: instances.id,
      sopInstanceUid: instances.sopInstanceUid,
    })
    .from(instances)
    .where(eq(instances.seriesId, seriesId));

  if (seriesInstances.length === 0) {
    return { ctx: null, error: "Aucune image dans la série" };
  }

  const annRows = await db
    .select({
      instanceId: annotations.instanceId,
      type: annotations.type,
      data: annotations.data,
    })
    .from(annotations)
    .innerJoin(instances, eq(annotations.instanceId, instances.id))
    .where(eq(instances.seriesId, seriesId));

  // Map each annotation's instanceId → its real SOP UID for the references.
  const sopByInstanceId = new Map(
    seriesInstances.map(i => [i.id, i.sopInstanceUid])
  );

  const exportAnnotations: import("./dicomDerived").ExportAnnotation[] = [];
  for (const a of annRows) {
    const sop = sopByInstanceId.get(a.instanceId);
    if (!sop) continue;
    exportAnnotations.push({
      type: a.type,
      data: a.data,
      referencedSopInstanceUid: sop,
    });
  }

  const ctx: import("./dicomDerived").ExportContext = {
    studyInstanceUid: row.studyInstanceUid,
    seriesInstanceUid: row.seriesInstanceUid,
    patient: {
      patientName: row.patientName,
      patientId: row.patientDicomId,
      birthDate: row.birthDate,
      sex: row.sex,
    },
    instances: seriesInstances.map(i => ({ sopInstanceUid: i.sopInstanceUid })),
    annotations: exportAnnotations,
  };
  return { ctx };
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => {
      // Never expose the password hash to the client.
      if (!opts.ctx.user) return null;
      const { passwordHash, ...safeUser } = opts.ctx
        .user as typeof opts.ctx.user & {
        passwordHash?: string | null;
      };
      return safeUser;
    }),

    // Self-hosted email/password registration. The first account created
    // becomes an admin; later accounts default to the unprivileged "user"
    // role and must be promoted to a clinical role to see PHI.
    register: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          password: z.string().min(8, "Password must be at least 8 characters"),
          name: z.string().min(1).max(128).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { ENV } = await import("./_core/env");
        if (ENV.authMode !== "local") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Registration disabled",
          });
        }
        const { getUserByEmail, countUsers, createLocalUser } = await import(
          "./db"
        );
        const { hashPassword } = await import("./localAuth");
        const { sdk } = await import("./_core/sdk");

        const email = input.email.trim().toLowerCase();
        if (await getUserByEmail(email)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Email already registered",
          });
        }

        const isFirstUser = (await countUsers()) === 0;
        const passwordHash = await hashPassword(input.password);
        const openId = `local:${crypto.randomUUID()}`;
        const user = await createLocalUser({
          openId,
          email,
          name: input.name ?? null,
          passwordHash,
          role: isFirstUser ? "admin" : "user",
        });
        if (!user) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "User creation failed",
          });
        }

        const token = await sdk.createSessionToken(openId, {
          name: input.name || "",
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: SEVEN_DAYS_MS,
        });
        return { success: true, user: { id: user.id, email, role: user.role } };
      }),

    login: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          password: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getUserByEmail } = await import("./db");
        const { verifyPassword } = await import("./localAuth");
        const { sdk } = await import("./_core/sdk");

        const email = input.email.trim().toLowerCase();
        const user = await getUserByEmail(email);
        // Generic error either way to avoid leaking which emails exist.
        if (
          !user ||
          !user.passwordHash ||
          !(await verifyPassword(input.password, user.passwordHash))
        ) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password",
          });
        }

        const token = await sdk.createSessionToken(user.openId, {
          name: user.name || "",
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: SEVEN_DAYS_MS,
        });
        return { success: true, user: { id: user.id, email, role: user.role } };
      }),

    logout: publicProcedure.mutation(async ({ ctx }) => {
      // Revoke all outstanding sessions for this user server-side, not just
      // clear the cookie on this device.
      if (ctx.user?.openId) {
        const { bumpSessionVersion } = await import("./db");
        await bumpSessionVersion(ctx.user.openId);
      }
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // Studies router
  studies: router({
    list: medicalProcedure
      .input(
        z
          .object({
            modality: z.string().max(16).optional(),
            timeFilter: z.string().max(40).optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return listStudies({
          modality: input?.modality,
          timeFilter: input?.timeFilter,
        });
      }),

    get: medicalProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const study = await getStudyById(input.id);
        await recordAccess({
          userId: ctx.user.id,
          action: "study.view",
          studyId: input.id,
          ipAddress: ctx.req?.ip ?? null,
        });
        return study;
      }),

    patientHistory: medicalProcedure
      .input(z.object({ studyId: z.number() }))
      .query(async ({ input }) => {
        const { listPriorStudiesForStudy } = await import("./db");
        const prior = await listPriorStudiesForStudy(input.studyId);
        const lines = prior.map(
          (s: any) =>
            `- ${s.studyDate || "?"} : ${s.modality || "?"}${s.studyDescription ? " — " + s.studyDescription : ""}`
        );
        const antecedents = lines.length
          ? "Antécédents d'imagerie (examens antérieurs du patient) :\n" +
            lines.join("\n")
          : "";
        return { antecedents, count: prior.length };
      }),

    updateStatus: adminProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["new", "in_progress", "reported", "finalized"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbCtx } = await import("./_core/dbCtx");
        const { db, schema, eq } = await dbCtx();
        const { studies } = schema;
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DB unavailable",
          });

        // Lire l'état AVANT mise à jour pour ne notifier que sur une transition.
        const before = await getStudyById(input.id);

        await db
          .update(studies)
          .set({ status: input.status })
          .where(eq(studies.id, input.id));

        // Notify if report finalized
        if (input.status === "finalized") {
          await createNotification({
            userId: ctx.user.id,
            type: "report_finalized",
            title: "Report finalized",
            message: `Study #${input.id} report has been finalized`,
            studyId: input.id,
          });
        }

        // Notification e-mail RIS sur transition vers "finalized" (opt-in).
        // Fail-soft : une erreur d'envoi ne fait jamais échouer la mutation.
        if (
          shouldNotify(
            before?.status,
            input.status,
            STATUS_TRIGGERS,
            ENV.risNotifyEmail
          )
        ) {
          try {
            await notifyReportFinalized({
              recipientEmail: ENV.risNotifyEmail,
              patientName: before?.patientName || "—",
              modality: before?.modality || "—",
              studyDate: before?.studyDate || "—",
              reportAuthor: ctx.user.email || ctx.user.openId || "—",
            });
          } catch (err: any) {
            console.warn(
              "[RIS] notifyReportFinalized échouée:",
              err?.message ?? err
            );
          }
        }

        return { success: true };
      }),

    updatePriority: adminProcedure
      .input(
        z.object({
          id: z.number(),
          priority: z.enum(["routine", "stat", "urgent"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbCtx } = await import("./_core/dbCtx");
        const { db, schema, eq } = await dbCtx();
        const { studies } = schema;
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DB unavailable",
          });

        // Lire l'état AVANT mise à jour pour ne notifier que sur une transition.
        const before = await getStudyById(input.id);

        await db
          .update(studies)
          .set({ priority: input.priority })
          .where(eq(studies.id, input.id));

        // Notify if STAT
        if (input.priority === "stat") {
          await createNotification({
            userId: ctx.user.id,
            type: "stat_urgent",
            title: "STAT priority assigned",
            message: `Study #${input.id} has been marked as STAT/urgent`,
            studyId: input.id,
          });
        }

        // Notification e-mail RIS sur transition vers "stat"/"urgent" (opt-in).
        // Fail-soft : une erreur d'envoi ne fait jamais échouer la mutation.
        if (
          shouldNotify(
            before?.priority,
            input.priority,
            PRIORITY_TRIGGERS,
            ENV.risNotifyEmail
          )
        ) {
          try {
            await notifyStatUrgent({
              recipientEmail: ENV.risNotifyEmail,
              patientName: before?.patientName || "—",
              modality: before?.modality || "—",
              studyDate: before?.studyDate || "—",
              studyDescription: before?.studyDescription || "—",
              urgencyReason: `Priorité passée à « ${input.priority} »`,
            });
          } catch (err: any) {
            console.warn(
              "[RIS] notifyStatUrgent échouée:",
              err?.message ?? err
            );
          }
        }

        return { success: true };
      }),

    anonymize: adminProcedure
      .input(
        z.object({
          id: z.number(),
          fields: z.array(z.string()),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { studies, patients } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DB unavailable",
          });

        const PLACEHOLDER = "[ANONYMIZED]";

        // Patient-identity fields live on the `patients` table; only report
        // metadata lives on `studies`. studies.patientId is an int FK to
        // patients.id, NOT the DICOM identity — never overwrite it here.
        const STUDY_FIELDS = new Set([
          "referringPhysician",
          "institution",
          "accessionNumber",
        ]);
        const PATIENT_FIELDS = new Set([
          "patientName",
          "patientId",
          "birthDate",
        ]);

        const studyUpdate: Partial<typeof studies.$inferInsert> = {};
        const patientUpdate: Partial<typeof patients.$inferInsert> = {};

        for (const field of input.fields) {
          if (STUDY_FIELDS.has(field)) {
            (studyUpdate as Record<string, unknown>)[field] = PLACEHOLDER;
          } else if (PATIENT_FIELDS.has(field)) {
            // Identités chiffrées au repos (nLPD) : on chiffre aussi le
            // remplaçant d'anonymisation (déterministe pour patientId).
            (patientUpdate as Record<string, unknown>)[field] =
              field === "birthDate"
                ? null
                : field === "patientId"
                  ? encryptDeterministic(PLACEHOLDER)
                  : encryptField(PLACEHOLDER);
          }
        }

        const studyCount = Object.keys(studyUpdate).length;
        const patientCount = Object.keys(patientUpdate).length;

        if (studyCount > 0) {
          await db
            .update(studies)
            .set(studyUpdate)
            .where(eq(studies.id, input.id));
        }

        if (patientCount > 0) {
          // Resolve the linked patient row, then anonymize it. This affects
          // every study of that patient — correct for identity removal.
          const [study] = await db
            .select({ patientId: studies.patientId })
            .from(studies)
            .where(eq(studies.id, input.id))
            .limit(1);
          if (!study)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Study not found",
            });
          await db
            .update(patients)
            .set(patientUpdate)
            .where(eq(patients.id, study.patientId));
        }

        await recordAccess({
          userId: ctx.user.id,
          action: "study.anonymize",
          studyId: input.id,
          detail: input.fields.join(","),
          ipAddress: ctx.req?.ip ?? null,
        });

        return { success: true, fieldsAnonymized: studyCount + patientCount };
      }),

    delete: strictAdminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const {
          studies,
          series,
          instances,
          annotations,
          notifications,
          albumStudies,
          reports,
          reportAddenda,
        } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DB unavailable",
          });

        // Delete child rows (no DB-level cascade), then the study itself,
        // so no annotations / notifications / album links are left orphaned.
        const studySeries = await db
          .select()
          .from(series)
          .where(eq(series.studyId, input.id));
        for (const s of studySeries) {
          const seriesInstances = await db
            .select()
            .from(instances)
            .where(eq(instances.seriesId, s.id));
          for (const inst of seriesInstances) {
            // Remove the DICOM object from storage so deleted studies leave no
            // orphaned PHI in the bucket. Best-effort: a storage hiccup must not
            // block the DB erasure — the study still disappears from the app.
            try {
              await storageDelete(inst.storageKey);
            } catch (err) {
              console.warn(
                `[studies.delete] could not remove object ${inst.storageKey}:`,
                err
              );
            }
            await db
              .delete(annotations)
              .where(eq(annotations.instanceId, inst.id));
          }
          await db.delete(instances).where(eq(instances.seriesId, s.id));
        }
        await db.delete(series).where(eq(series.studyId, input.id));
        await db
          .delete(notifications)
          .where(eq(notifications.studyId, input.id));
        await db.delete(albumStudies).where(eq(albumStudies.studyId, input.id));

        // Compte-rendu de l'étude : le report (PHI clinique) et ses addenda
        // doivent disparaître eux aussi, et son PDF nominatif être purgé du
        // bucket — sinon une « suppression » laisse du PHI résiduel (droit à
        // l'effacement nLPD/RGPD). Cf. audit C1.
        const report = await getReportByStudy(input.id);
        if (report) {
          if (report.pdfStorageKey) {
            try {
              await storageDelete(report.pdfStorageKey);
            } catch (err) {
              console.warn(
                `[studies.delete] could not remove report PDF ${report.pdfStorageKey}:`,
                err
              );
            }
          }
          await db
            .delete(reportAddenda)
            .where(eq(reportAddenda.reportId, report.id));
          await db.delete(reports).where(eq(reports.studyId, input.id));
        }

        await db.delete(studies).where(eq(studies.id, input.id));

        await recordAccess({
          userId: ctx.user.id,
          action: "study.delete",
          studyId: input.id,
          ipAddress: ctx.req?.ip ?? null,
        });

        return { success: true };
      }),

    // Partage INTERNE d'une étude : transmet à un confrère MediView via une
    // notification. Mono-tenant → n'octroie aucun accès nouveau ; PHI-safe,
    // audité (recordAccess). Lien externe/OTP hors scope.
    share: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          recipientUserId: z.number().int(),
          note: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const recent = await countRecentAccess(ctx.user.id, "study.share", 60);
        if (recent >= 60)
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Limite atteinte.",
          });
        if (input.recipientUserId === ctx.user.id)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Destinataire invalide.",
          });
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        const clinical = await listClinicalUsers(ctx.user.id);
        if (!clinical.some(u => u.id === input.recipientUserId))
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Destinataire non clinique.",
          });
        const { title, message } = buildShareNotification(
          ctx.user.name ?? "",
          input.note
        );
        await createNotification({
          userId: input.recipientUserId,
          type: "shared_study",
          title,
          message,
          studyId: input.studyId,
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "study.share",
          studyId: input.studyId,
          detail: `to=${input.recipientUserId}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
  }),

  // Series router
  series: router({
    listByStudy: medicalProcedure
      .input(z.object({ studyId: z.number() }))
      .query(async ({ input }) => {
        return listSeriesByStudy(input.studyId);
      }),
  }),

  // Instances router
  instances: router({
    listBySeries: medicalProcedure
      .input(z.object({ seriesId: z.number() }))
      .query(async ({ input }) => {
        return listInstancesBySeries(input.seriesId);
      }),
  }),

  // DICOM Import router
  dicom: router({
    import: medicalProcedure
      .input(
        z.object({
          patientId: z.string(),
          patientName: z.string(),
          birthDate: z.string().optional(),
          sex: z.string().optional(),
          studyInstanceUid: z.string(),
          studyDate: z.string().optional(),
          studyTime: z.string().optional(),
          studyDescription: z.string().optional(),
          accessionNumber: z.string().optional(),
          referringPhysician: z.string().optional(),
          performingPhysician: z.string().optional(),
          institution: z.string().optional(),
          modality: z.string().optional(),
          seriesInstanceUid: z.string(),
          seriesNumber: z.number().optional(),
          seriesDescription: z.string().optional(),
          bodyPart: z.string().optional(),
          sopInstanceUid: z.string(),
          instanceNumber: z.number().optional(),
          rows: z.number().optional(),
          columns: z.number().optional(),
          bitsAllocated: z.number().optional(),
          windowCenter: z.string().optional(),
          windowWidth: z.string().optional(),
          // base64 d'un fichier DICOM. Borne explicite (audit) : défense en
          // profondeur contre un DoS mémoire (buffer décodé par requête),
          // alignée sur la limite du body-parser (~50 Mo). 60M chars base64 ≈ 45 Mo binaire.
          fileData: z.string().min(1).max(60_000_000),
          fileSize: z.number().int().min(0).max(60_000_000),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // 1. Find or create patient (anonymized storage path)
        const patient = await findOrCreatePatient({
          patientId: input.patientId,
          patientName: input.patientName,
          birthDate: input.birthDate,
          sex: input.sex,
        });

        // 2. Create study
        const study = await createStudy({
          patientId: patient.id,
          studyInstanceUid: input.studyInstanceUid,
          studyDate: input.studyDate,
          studyTime: input.studyTime,
          studyDescription: input.studyDescription,
          accessionNumber: input.accessionNumber,
          referringPhysician: input.referringPhysician,
          performingPhysician: input.performingPhysician,
          institution: input.institution,
          modality: input.modality,
        });

        // 3. Create series
        const seriesRecord = await createSeries({
          studyId: study.id,
          seriesInstanceUid: input.seriesInstanceUid,
          seriesNumber: input.seriesNumber,
          seriesDescription: input.seriesDescription,
          modality: input.modality,
          bodyPart: input.bodyPart,
        });

        // 4. Anonymize DICOM metadata in file before S3 upload
        const storageKey = `dicom/${patient.id}/${study.id}/${seriesRecord.id}/${input.sopInstanceUid}.dcm`;
        const rawBuffer = Buffer.from(input.fileData, "base64");
        const fileBuffer = anonymizeDicomBuffer(rawBuffer);

        const { key, url } = await storagePut(
          storageKey,
          fileBuffer,
          "application/dicom"
        );

        // 5. Create instance record
        const instance = await createInstance({
          seriesId: seriesRecord.id,
          sopInstanceUid: input.sopInstanceUid,
          instanceNumber: input.instanceNumber,
          storageKey: key,
          storageUrl: url,
          rows: input.rows,
          columns: input.columns,
          bitsAllocated: input.bitsAllocated,
          windowCenter: input.windowCenter,
          windowWidth: input.windowWidth,
          fileSize: input.fileSize,
        });

        // 6. Update counts
        await updateSeriesCount(seriesRecord.id);
        await updateStudyCounts(study.id);

        // 7. Create notification for new study
        await createNotification({
          userId: ctx.user.id,
          type: "new_study",
          title: `New ${input.modality || "DICOM"} study received`,
          message: `Patient: ${input.patientName}, Study: ${input.studyDescription || "N/A"}`,
          studyId: study.id,
        });

        return {
          success: true,
          studyId: study.id,
          seriesId: seriesRecord.id,
          instanceId: instance.id,
        };
      }),
  }),

  // Annotations router
  annotations: router({
    save: medicalProcedure
      .input(
        z.object({
          instanceId: z.number(),
          type: z.enum(["length", "angle", "rect_roi", "ellipse_roi", "text"]),
          data: annotationDataSchema,
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { annotations } = await import("../drizzle/schema");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        await db.insert(annotations).values({
          instanceId: input.instanceId,
          userId: ctx.user.id,
          type: input.type,
          data: input.data,
        });

        return { success: true };
      }),

    // Suppression d'une mesure (ROI Manager). Réservé au rôle médical
    // (medicalProcedure) ; cohérent avec save (déploiement self-host mono-cabinet,
    // le personnel médical partage le même périmètre de confiance).
    delete: medicalProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const { getDb } = await import("./db");
        const { annotations } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(annotations).where(eq(annotations.id, input.id));
        return { success: true };
      }),

    listByInstance: medicalProcedure
      .input(z.object({ instanceId: z.number() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const { annotations } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return [];

        return db
          .select()
          .from(annotations)
          .where(eq(annotations.instanceId, input.instanceId));
      }),

    // All saved annotations for every instance in a series. Used by the viewer
    // to re-hydrate measurements when a series loads, in a single round-trip
    // instead of one query per slice.
    listBySeries: medicalProcedure
      .input(z.object({ seriesId: z.number() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const { annotations, instances } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return [];

        const rows = await db
          .select({
            id: annotations.id,
            instanceId: annotations.instanceId,
            userId: annotations.userId,
            type: annotations.type,
            data: annotations.data,
            createdAt: annotations.createdAt,
          })
          .from(annotations)
          .innerJoin(instances, eq(annotations.instanceId, instances.id))
          .where(eq(instances.seriesId, input.seriesId));

        return rows;
      }),

    // Export the saved annotations of a series as a DICOM SR (measurements) or
    // GSPS (graphic presentation state), returned as base64 Part-10 bytes for
    // download. Anti-IDOR: the series must resolve to a real study/patient via
    // the join chain (series → study → patient); the medical role is already
    // required. Built server-side with dcmjs. Fail-safe: never throws on an
    // empty/incomplete annotation set — emits a valid (possibly empty) object.
    exportSr: medicalProcedure
      .input(z.object({ seriesId: z.number() }))
      .mutation(async ({ input }) => {
        const { ctx, error } = await buildSeriesExportContext(input.seriesId);
        if (!ctx) return { success: false as const, error };
        const { buildStructuredReport } = await import("./dicomDerived");
        const { buffer, sopInstanceUid } = buildStructuredReport(ctx);
        return {
          success: true as const,
          sopInstanceUid,
          filename: `SR_${sopInstanceUid}.dcm`,
          dicomBase64: buffer.toString("base64"),
        };
      }),

    exportGsps: medicalProcedure
      .input(z.object({ seriesId: z.number() }))
      .mutation(async ({ input }) => {
        const { ctx, error } = await buildSeriesExportContext(input.seriesId);
        if (!ctx) return { success: false as const, error };
        const { buildPresentationState } = await import("./dicomDerived");
        const { buffer, sopInstanceUid } = buildPresentationState(ctx);
        return {
          success: true as const,
          sopInstanceUid,
          filename: `GSPS_${sopInstanceUid}.dcm`,
          dicomBase64: buffer.toString("base64"),
        };
      }),
  }),

  // Export router
  export: router({
    dicomSeries: medicalProcedure
      .input(z.object({ studyId: z.number() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const { series, instances } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Get all instances for this study's series
        const studySeries = await db
          .select()
          .from(series)
          .where(eq(series.studyId, input.studyId));
        const allInstances = [];
        for (const s of studySeries) {
          const seriesInstances = await db
            .select()
            .from(instances)
            .where(eq(instances.seriesId, s.id));
          allInstances.push(...seriesInstances);
        }

        // Return storage URLs for download
        return allInstances.map(inst => ({
          sopInstanceUid: inst.sopInstanceUid,
          storageUrl: inst.storageUrl,
          instanceNumber: inst.instanceNumber,
        }));
      }),

    pdfReport: medicalProcedure
      .input(
        z.object({
          studyId: z.number(),
          annotations: z
            .array(
              z.object({
                type: z.string(),
                label: z.string().optional(),
                value: z.string().optional(),
              })
            )
            .optional(),
        })
      )
      .query(async ({ input }) => {
        const study = await getStudyById(input.studyId);
        if (!study) throw new TRPCError({ code: "NOT_FOUND" });

        // Generate a basic PDF report structure (returned as JSON for client-side PDF generation)
        return {
          title: `Radiology Report - ${study.patientName || "Unknown"}`,
          patient: {
            name: study.patientName,
            id: study.patientId,
            birthDate: study.birthDate,
          },
          study: {
            date: study.studyDate,
            modality: study.modality,
            description: study.studyDescription,
            institution: study.institution,
            referringPhysician: study.referringPhysician,
            numberOfSeries: study.numberOfSeries,
            numberOfInstances: study.numberOfInstances,
          },
          annotations: input.annotations || [],
          generatedAt: new Date().toISOString(),
        };
      }),
  }),

  // Notifications router
  notifications: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return getUserNotifications(ctx.user.id);
    }),

    markRead: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await markNotificationRead(input.id, ctx.user.id);
        return { success: true };
      }),
  }),

  // Comptes utilisateurs (destinataires de partage interne).
  users: router({
    listClinical: medicalProcedure.query(async ({ ctx }) => {
      return listClinicalUsers(ctx.user.id);
    }),
  }),

  // Orthanc PACS router
  orthanc: router({
    status: medicalProcedure.query(async () => {
      return checkOrthancConnection();
    }),

    modalities: medicalProcedure.query(async () => {
      return listModalities();
    }),

    // Modality Worklist (MWL) query — read-only scheduled procedure steps.
    // Fail-soft: returns { available:false } when no worklist is configured on
    // the demo PACS, so the UI shows "Worklist indisponible" without breaking.
    worklist: medicalProcedure
      .input(
        z.object({
          aet: aeTitleSchema,
          patientName: z.string().max(64).optional(),
          patientId: z.string().max(64).optional(),
          accessionNumber: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const query: Record<string, string> = {};
        if (input.patientName) query.PatientName = input.patientName;
        if (input.patientId) query.PatientID = input.patientId;
        if (input.accessionNumber)
          query.AccessionNumber = input.accessionNumber;
        const res = await findWorklist({ aet: input.aet, query });
        if (!res.available) {
          return { available: false, entries: [] as const };
        }
        return {
          available: true,
          entries: parseWorklistAnswers(res.answers),
        };
      }),

    queryStudies: medicalProcedure
      .input(
        z.object({
          patientName: z.string().optional(),
          patientId: z.string().optional(),
          studyDate: z.string().optional(),
          modality: z.string().optional(),
          accessionNumber: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const results = await qidoSearchStudies(input);
          return { success: true, results };
        } catch (err: any) {
          return { success: false, results: [], error: err.message };
        }
      }),

    cFind: medicalProcedure
      .input(
        z.object({
          aet: aeTitleSchema,
          level: z.enum(["Study", "Series", "Instance"]),
          query: z.record(z.string().max(64), z.string().max(256)),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const results = await cFind(input);
          return { success: true, results };
        } catch (err) {
          // Don't leak internal Orthanc/error details to the client.
          console.error("cFind failed:", err);
          return {
            success: false,
            results: [],
            error: "C-FIND request failed",
          };
        }
      }),

    // C-MOVE can exfiltrate whole studies to an arbitrary AET — admin only.
    cMove: strictAdminProcedure
      .input(
        z.object({
          sourceAet: aeTitleSchema,
          targetAet: aeTitleSchema,
          studyInstanceUID: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        return cMove(input);
      }),

    // C-STORE pushes a whole study (PHI) to an external modality — admin only.
    cStore: strictAdminProcedure
      .input(
        z.object({
          targetAet: aeTitleSchema,
          studyInstanceUID: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const result = await cStoreStudy(input);
        await recordAccess({
          userId: ctx.user.id,
          action: "study.cstore",
          studyId: null,
          ipAddress: ctx.req?.ip ?? null,
        });
        return result;
      }),
  }),

  // PACS Servers CRUD router
  pacsServers: router({
    list: medicalProcedure.query(async ({ ctx }) => {
      const { dbCtx } = await import("./_core/dbCtx");
      const { db, schema, eq } = await dbCtx();
      const { pacsServers } = schema;
      if (!db) return [];
      return db
        .select()
        .from(pacsServers)
        .where(eq(pacsServers.userId, ctx.user.id));
    }),

    // Configuring a PACS endpoint defines where studies can be C-MOVE'd —
    // admin/radiologist only, not every logged-in account.
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          aeTitle: aeTitleSchema,
          host: z.string().min(1),
          port: z.number().min(1).max(65535),
          orthancUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { pacsServers } = await import("../drizzle/schema");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(pacsServers).values({
          name: input.name,
          aeTitle: input.aeTitle,
          host: input.host,
          port: input.port,
          orthancUrl: input.orthancUrl || null,
          userId: ctx.user.id,
        });
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { pacsServers } = await import("../drizzle/schema");
        const { eq, and } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db
          .delete(pacsServers)
          .where(
            and(
              eq(pacsServers.id, input.id),
              eq(pacsServers.userId, ctx.user.id)
            )
          );
        return { success: true };
      }),
  }),

  // Email notifications router
  email: router({
    status: medicalProcedure.query(() => {
      return getSmtpStatus();
    }),

    sendTest: strictAdminProcedure
      .input(z.object({ to: z.string().email() }))
      .mutation(async ({ input }) => {
        return sendEmail({
          to: input.to,
          subject: "[MediView] Test Email",
          html: "<p>This is a test email from MediView. SMTP is configured correctly.</p>",
        });
      }),

    // Email an imaging report to a recipient who can read it straight from
    // their inbox. The PDF is ASSEMBLED SERVER-SIDE from the authoritative study
    // record + the client-supplied rendered PNG (never a client-supplied PDF),
    // so the document content is bounded and this can't be used to relay
    // arbitrary attacker-chosen attachments / phishing. Rate-limited per user;
    // every send is access-logged (PHI egress).
    sendReport: medicalProcedure
      .input(
        z.object({
          to: z.string().email(),
          studyId: z.number(),
          message: z.string().max(500).optional(),
          imagePngBase64: z.string().min(1).max(10_000_000), // ~7.5 MB cap
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { countRecentAccess } = await import("./db");
        // Rate limit: cap report emails per user per hour.
        const recent = await countRecentAccess(
          ctx.user.id,
          "study.email.report",
          60
        );
        if (recent >= 20) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Limite d'envois atteinte, réessayez plus tard.",
          });
        }

        // Authorize against a real study the server loaded — never trust the
        // client for the subject/audit/PDF content.
        const study = await getStudyById(input.studyId);
        if (!study) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Study not found",
          });
        }

        // Validate the image is a real PNG and read its dimensions (IHDR).
        const png = Buffer.from(input.imagePngBase64, "base64");
        const PNG_SIG = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIG)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Image must be a PNG",
          });
        }
        const imgW = png.readUInt32BE(16);
        const imgH = png.readUInt32BE(20);

        // Build the PDF server-side from trusted study data + the image.
        const { jsPDF } = await import("jspdf");
        const doc = new jsPDF();
        doc.setFontSize(15);
        doc.text("Compte rendu d'imagerie", 14, 16);
        doc.setFontSize(10);
        [
          `Patient : ${study.patientName || "—"}`,
          `Date d'étude : ${study.studyDate || "—"}`,
          `Modalité : ${study.modality || "—"}`,
          `Description : ${study.studyDescription || "—"}`,
          `Institution : ${study.institution || "—"}`,
        ].forEach((line, i) => doc.text(line, 14, 28 + i * 6));
        const pageW = 180;
        const drawH = imgW > 0 ? Math.min(210, (imgH / imgW) * pageW) : 120;
        doc.addImage(
          `data:image/png;base64,${input.imagePngBase64}`,
          "PNG",
          14,
          62,
          pageW,
          drawH
        );
        const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

        const subjectName = study.patientName ? ` — ${study.patientName}` : "";
        const result = await sendEmail({
          to: input.to,
          subject: `Compte rendu d'imagerie${subjectName}`,
          html:
            `<div style="font-family:sans-serif;max-width:600px">` +
            `<p>Bonjour,</p>` +
            `<p>Veuillez trouver ci-joint le compte rendu d'imagerie au format PDF.</p>` +
            (input.message
              ? `<p>${input.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
              : "") +
            `<p style="color:#888;font-size:12px">Document médical confidentiel — destiné au seul destinataire.</p>` +
            `</div>`,
          attachments: [
            {
              filename: `compte-rendu-${study.id}.pdf`,
              content: pdfBuffer,
              contentType: "application/pdf",
            },
          ],
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "study.email.report",
          studyId: study.id,
          detail: input.to,
          ipAddress: ctx.req?.ip ?? null,
        });
        if (!result.success) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: result.error || "Email send failed",
          });
        }
        return { success: true };
      }),

    // Email a full structured imaging report (compte rendu) assembled
    // SERVER-SIDE: PDF from the authoritative study record + client-supplied
    // rendered key-image PNGs, plus an optional ciné MP4 rebuilt server-side
    // from the series' DICOM frames. Never relays client-supplied binaries
    // verbatim. Rate-limited per user; every send is access-logged (PHI egress).
    sendStudyReport: adminProcedure
      .input(
        z.object({
          to: z.string().email(),
          studyId: z.number(),
          seriesId: z.number(),
          // Conservés pour la compat de l'input mais IGNORÉS : le contenu et la
          // signature sont serveur-autoritatifs (CR signé en DB). Cf. audit I1.
          report: z
            .object({
              indication: z.string().max(5000),
              technique: z.string().max(5000),
              resultats: z.string().max(20000),
              conclusion: z.string().max(5000),
            })
            .optional(),
          signature: z.string().min(1).max(120).optional(),
          windowCenter: z.number().finite(),
          windowWidth: z.number().finite(),
          keyImages: z
            .array(
              z.object({
                pngBase64: z.string().min(1).max(10_000_000),
                sliceIndex: z.number().int().min(0),
                measurements: z.string().max(500).optional(),
              })
            )
            .max(20),
          includeVideo: z.boolean(),
          message: z.string().max(500).optional(),
          aiAssisted: z.boolean().optional(),
          antecedents: z.string().max(5000).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { sendStudyReportImpl } = await import(
          "./report/sendStudyReport"
        );
        return sendStudyReportImpl(input, ctx as any);
      }),

    aiPreanalysis: medicalProcedure
      .input(
        z.object({
          studyId: z.number(),
          keyImages: z
            .array(
              z.object({
                pngBase64: z.string().min(1).max(10_000_000),
                sliceIndex: z.number().int().min(0),
              })
            )
            // 0 autorisé : le serveur échantillonne TOUTE la série lui-même
            // (sampleSeriesPngs) à partir de seriesId — pas besoin d'une image
            // clé capturée côté client (qui échoue notamment en 3D/VR).
            .min(0)
            .max(20),
          indication: z.string().max(5000).optional(),
          antecedents: z.string().max(5000).optional(),
          // Échantillonnage serveur du volume (analyse de toute la série).
          seriesId: z.number().int().optional(),
          windowCenter: z.number().optional(),
          windowWidth: z.number().optional(),
          sampleCount: z.number().int().min(1).max(24).optional(),
          // Mode précis (CT) : ancrer le rapport dans les volumes segmentés.
          includeSegmentation: z.boolean().optional(),
          highResSegmentation: z.boolean().optional(),
          // Double lecture : avis d'un 2e modèle (détecte les désaccords).
          doubleRead: z.boolean().optional(),
          // Analyser TOUTES les séries du dossier (auto à l'ouverture).
          wholeStudy: z.boolean().optional(),
          // Comparaison auto avec toutes les antériorités du patient.
          compareAllPriors: z.boolean().optional(),
          // Analyse approfondie (beaucoup plus de coupes) — toujours active.
          deepAnalysis: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { runAiPreanalysis } = await import("./report/aiPreanalysis");
        return runAiPreanalysis(input, ctx as any);
      }),

    notifyNewStudy: medicalProcedure
      .input(
        z.object({
          recipientEmail: z.string().email(),
          patientName: z.string(),
          modality: z.string(),
          studyDate: z.string(),
          studyDescription: z.string(),
          institution: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await guardPhiNotify(input.recipientEmail, ctx);
        return notifyNewStudy(input);
      }),

    notifyStatUrgent: medicalProcedure
      .input(
        z.object({
          recipientEmail: z.string().email(),
          patientName: z.string(),
          modality: z.string(),
          studyDate: z.string(),
          studyDescription: z.string(),
          urgencyReason: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await guardPhiNotify(input.recipientEmail, ctx);
        return notifyStatUrgent(input);
      }),

    notifyReportFinalized: medicalProcedure
      .input(
        z.object({
          recipientEmail: z.string().email(),
          patientName: z.string(),
          modality: z.string(),
          studyDate: z.string(),
          reportAuthor: z.string(),
          reportSummary: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await guardPhiNotify(input.recipientEmail, ctx);
        return notifyReportFinalized(input);
      }),
  }),

  // Journal d'audit (access_logs) : consultation/export et rétention.
  // Réservé aux administrateurs (garde stricte). L'export est aussi exposé en
  // CSV via la route Express GET /api/audit/export.csv (même garde).
  audit: router({
    // Renvoie les lignes du journal d'accès (cap AUDIT_EXPORT_MAX) pour que
    // l'admin les télécharge / construise un CSV côté client.
    export: strictAdminProcedure
      .input(
        z
          .object({
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            limit: z.number().int().min(1).optional(),
          })
          .optional()
      )
      .query(async ({ input, ctx }) => {
        const { queryAuditLogs, AUDIT_EXPORT_MAX } = await import("./audit");
        const rows = await queryAuditLogs(input ?? {});
        // Tracer l'export du journal lui-même (méta-audit, sans PHI).
        await recordAccess({
          userId: ctx.user.id,
          action: "audit.export",
          studyId: null,
          detail: `rows=${rows.length}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { rows, cap: AUDIT_EXPORT_MAX };
      }),
  }),

  // Rétention : purge explicite (jamais automatique) des vieilles entrées
  // d'audit. Action destructive → garde admin stricte + plancher de sécurité.
  retention: router({
    purge: strictAdminProcedure
      .input(z.object({ olderThanDays: z.number().int().min(30) }))
      .mutation(async ({ input, ctx }) => {
        const { purgeAuditLogs } = await import("./audit");
        const deleted = await purgeAuditLogs(input.olderThanDays);
        await recordAccess({
          userId: ctx.user.id,
          action: "audit.purge",
          studyId: null,
          detail: `olderThanDays=${input.olderThanDays};deleted=${deleted}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { deleted };
      }),
  }),

  // Compte-rendu radiologique (assistance IA → relecture/correction → signature
  // médecin → PDF). Lecture = medicalProcedure ; toute action d'écriture =
  // adminProcedure (admin|radiologist). Immuabilité après signature : seules les
  // corrections par addendum sont permises (verrou applicatif).
  reports: router({
    // Lecture du compte-rendu d'une étude (+ ses addenda).
    getByStudy: medicalProcedure
      .input(z.object({ studyId: z.number() }))
      .query(async ({ input }) => {
        const report = await getReportByStudy(input.studyId);
        if (!report) return { report: null, addenda: [] as any[] };
        const addenda = await getReportAddenda(report.id);
        return { report, addenda };
      }),

    pendingSignature: medicalProcedure.query(async () => {
      const { listPendingSignatureReports } = await import("./db");
      return { items: await listPendingSignatureReports() };
    }),

    // Création / mise à jour du brouillon. Refuse toute modification d'un
    // compte-rendu déjà signé (immuable → addendum).
    upsertDraft: adminProcedure
      .input(
        z.object({
          studyId: z.number(),
          sections: z.object({
            indication: z.string(),
            technique: z.string(),
            resultats: z.string(),
            conclusion: z.string(),
          }),
          aiGenerated: z.boolean().optional(),
          aiModel: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const existing = await getReportByStudy(input.studyId);
        if (existing && existing.status === "signed") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Compte-rendu signé : non modifiable (ajoutez un addendum).",
          });
        }
        const sections = validateReportSections(input.sections);
        if (existing) {
          await db
            .update(reports)
            .set({
              ...sections,
              aiGenerated: input.aiGenerated ?? existing.aiGenerated,
              aiModel: input.aiModel ?? existing.aiModel,
            })
            .where(eq(reports.id, existing.id));
          await recordAccess({
            userId: ctx.user.id,
            action: "report.draft",
            studyId: input.studyId,
            detail: "update",
            ipAddress: ctx.req?.ip ?? null,
          });
          return { id: existing.id };
        }
        await db.insert(reports).values({
          studyId: input.studyId,
          status: "draft",
          ...sections,
          aiGenerated: input.aiGenerated ?? false,
          aiModel: input.aiModel ?? null,
          createdBy: ctx.user.id,
        });
        // studyId est unique sur `reports` : on relit le brouillon créé pour en
        // récupérer l'id (le repo ne dépend pas de insertId du driver MySQL).
        const created = await getReportByStudy(input.studyId);
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Compte-rendu créé mais introuvable.",
          });
        }
        await recordAccess({
          userId: ctx.user.id,
          action: "report.draft",
          studyId: input.studyId,
          detail: "create",
          ipAddress: ctx.req?.ip ?? null,
        });
        return { id: created.id };
      }),

    // Pré-analyse IA → sections de brouillon proposées (non persistées ici ;
    // c'est upsertDraft qui enregistre après relecture du médecin).
    aiGenerate: adminProcedure
      .input(
        z.object({
          studyId: z.number(),
          seriesId: z.number().optional(),
          indication: z.string().optional(),
          antecedents: z.string().optional(),
          keyImages: z
            .array(z.object({ pngBase64: z.string(), sliceIndex: z.number() }))
            .default([]),
          priorStudyId: z.number().int().optional(),
          priorSeriesId: z.number().int().optional(),
          // Analyser TOUTES les séries du dossier (pas seulement la série vue).
          wholeStudy: z.boolean().optional(),
          // Analyse approfondie : beaucoup plus de coupes (cas douteux).
          deepAnalysis: z.boolean().optional(),
          // Double lecture (2e modèle) — activée par défaut côté UI simplifiée.
          doubleRead: z.boolean().optional(),
          // Comparaison auto avec TOUTES les antériorités du patient.
          compareAllPriors: z.boolean().optional(),
          // Segmentation/mesures (CT) ancrées dans le rapport.
          includeSegmentation: z.boolean().optional(),
          highResSegmentation: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Antériorité explicite (mode comparatif du viewer) sinon la plus
        // récente du même patient (helper DB existant). Fail-soft : aucune
        // antériorité → génération simple inchangée. En mode compareAllPriors,
        // on NE fixe PAS une antériorité unique (runAiPreanalysis les gère toutes).
        let priorStudyId = input.priorStudyId;
        if (!priorStudyId && !input.compareAllPriors) {
          const { listPriorStudiesForStudy } = await import("./db");
          const priors = await listPriorStudiesForStudy(input.studyId);
          priorStudyId = priors[0]?.id;
        }
        // runAiPreanalysis renvoie déjà des sections structurées
        // (technique/resultats/conclusion) — pas de re-parsing de texte brut.
        const result = await runAiPreanalysis(
          {
            studyId: input.studyId,
            seriesId: input.seriesId,
            indication: input.indication,
            antecedents: input.antecedents,
            keyImages: input.keyImages,
            priorStudyId,
            priorSeriesId: input.priorSeriesId,
            wholeStudy: input.wholeStudy,
            deepAnalysis: input.deepAnalysis,
            doubleRead: input.doubleRead,
            compareAllPriors: input.compareAllPriors,
            includeSegmentation: input.includeSegmentation,
            highResSegmentation: input.highResSegmentation,
          },
          { user: { id: ctx.user.id }, req: { ip: ctx.req?.ip } }
        );
        const sections = validateReportSections({
          indication: input.indication ?? "",
          technique: result.technique,
          resultats: result.resultats,
          conclusion: result.conclusion,
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "report.generate",
          studyId: input.studyId,
          detail: result.comparedPriorDate
            ? `${result.model} compared:${priorStudyId}`
            : result.model,
          ipAddress: ctx.req?.ip ?? null,
        });
        return {
          sections,
          aiModel: result.model,
          keyImage: result.keyImage ?? null,
          evolution: result.evolution ?? null,
          comparedPriorDate: result.comparedPriorDate ?? null,
        };
      }),

    // Signature : verrouille le compte-rendu (draft→signed), génère le PDF et le
    // stocke. canSignReport impose une conclusion non vide + statut draft.
    sign: adminProcedure
      .input(z.object({ reportId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select()
          .from(reports)
          .where(eq(reports.id, input.reportId))
          .limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        const sections = validateReportSections(report);
        if (!canSignReport(report.status as any, sections)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Conclusion requise, ou déjà signé.",
          });
        }
        const study = await getStudyById(report.studyId);
        const signedAt = new Date();
        const signature = `Signé par ${ctx.user.name ?? "Dr"} le ${signedAt.toLocaleString("fr-CH")}`;
        const pdf = buildReportPdf({
          study: study as any,
          report: sections,
          signature,
          keyImages: [],
          aiAssisted: report.aiGenerated,
        });
        // storagePut suffixe la clé (hash anti-collision) : on persiste la clé
        // RÉELLEMENT stockée (sa valeur de retour), pas la clé demandée.
        const { key } = await storagePut(
          `reports/${report.studyId}/report-${report.id}.pdf`,
          pdf,
          "application/pdf"
        );
        await db
          .update(reports)
          .set({
            status: "signed",
            signedBy: ctx.user.id,
            signedAt,
            pdfStorageKey: key,
          })
          .where(eq(reports.id, report.id));
        await recordAccess({
          userId: ctx.user.id,
          action: "report.sign",
          studyId: report.studyId,
          detail: `report ${report.id}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { success: true, pdfStorageKey: key };
      }),

    // Signature + envoi automatique au référent. Garde dure : le CR doit être
    // signé ET un e-mail doit être connu avant tout envoi (assertSendable).
    // Si le CR est déjà signé, on saute la phase signature et on envoie directement.
    signAndSend: adminProcedure
      .input(
        z.object({
          reportId: z.number(),
          recipientEmail: z.string().email().optional(),
          windowCenter: z.number().finite().default(40),
          windowWidth: z.number().finite().default(400),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const {
          getDb,
          getStudyById,
          listSeriesByStudy,
          upsertReferringEmail,
          resolveReferringEmail,
        } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const { assertSendable } = await import("./report/signAndSend");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const rows = await db
          .select()
          .from(reports)
          .where(eq(reports.id, input.reportId))
          .limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        const sections = validateReportSections(report);
        const study = (await getStudyById(report.studyId)) as any;

        const email =
          input.recipientEmail ??
          (await resolveReferringEmail(study?.referringPhysician));
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "E-mail du référent requis (renseignez-le).",
          });
        }
        if (input.recipientEmail && study?.referringPhysician) {
          await upsertReferringEmail(
            study.referringPhysician,
            input.recipientEmail
          );
        }

        if (report.status !== "signed") {
          if (!canSignReport(report.status as any, sections)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Conclusion requise pour signer.",
            });
          }
          const signedAt = new Date();
          const signature = `Signé par ${ctx.user.name ?? "Dr"} le ${signedAt.toLocaleString("fr-CH")}`;
          const pdf = buildReportPdf({
            study,
            report: sections,
            signature,
            keyImages: [],
            aiAssisted: report.aiGenerated,
          });
          const { key } = await storagePut(
            `reports/${report.studyId}/report-${report.id}.pdf`,
            pdf,
            "application/pdf"
          );
          await db
            .update(reports)
            .set({
              status: "signed",
              signedBy: ctx.user.id,
              signedAt,
              pdfStorageKey: key,
            })
            .where(eq(reports.id, report.id));
          await recordAccess({
            userId: ctx.user.id,
            action: "report.sign",
            studyId: report.studyId,
            detail: `report ${report.id} (signAndSend)`,
            ipAddress: ctx.req?.ip ?? null,
          });
        }

        assertSendable("signed", email);
        const series = await listSeriesByStudy(report.studyId);
        const { sendStudyReportImpl } = await import(
          "./report/sendStudyReport"
        );
        await sendStudyReportImpl(
          {
            to: email,
            studyId: report.studyId,
            seriesId: (series as any)[0]?.id ?? 0,
            windowCenter: input.windowCenter,
            windowWidth: input.windowWidth,
            keyImages: [],
            includeVideo: false,
            aiAssisted: report.aiGenerated,
          } as any,
          ctx as any
        );
        try {
          const { logAgentActivity } = await import("./agents/state");
          await logAgentActivity("referent", "sendReport", "ok", {
            studyId: report.studyId,
          });
        } catch {
          /* best-effort */
        }
        return { ok: true, email };
      }),

    // Addendum (correction post-signature) : append-only, possible uniquement
    // sur un compte-rendu signé. Régénère le PDF avec l'historique des addenda.
    addAddendum: adminProcedure
      .input(z.object({ reportId: z.number(), text: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports, reportAddenda } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select()
          .from(reports)
          .where(eq(reports.id, input.reportId))
          .limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        if (!canAddAddendum(report.status as any)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Addendum possible uniquement sur un compte-rendu signé.",
          });
        }
        await db.insert(reportAddenda).values({
          reportId: report.id,
          text: input.text,
          createdBy: ctx.user.id,
        });
        const addenda = await getReportAddenda(report.id);
        const study = await getStudyById(report.studyId);
        const signature = report.signedAt
          ? `Signé le ${new Date(report.signedAt).toLocaleString("fr-CH")}`
          : "";
        const pdf = buildReportPdf({
          study: study as any,
          report: validateReportSections(report),
          signature,
          keyImages: [],
          aiAssisted: report.aiGenerated,
          addenda: addenda.map((a: any) => ({
            text: a.text,
            date: new Date(a.createdAt).toLocaleString("fr-CH"),
            author: `Dr (#${a.createdBy})`,
          })),
        });
        // storagePut suffixe TOUJOURS la clé de base : on lui passe la clé de
        // base (jamais report.pdfStorageKey, déjà suffixée → double suffixe +
        // objets orphelins) et on persiste la clé réelle retournée.
        const { key } = await storagePut(
          `reports/${report.studyId}/report-${report.id}.pdf`,
          pdf,
          "application/pdf"
        );
        await db
          .update(reports)
          .set({ pdfStorageKey: key })
          .where(eq(reports.id, report.id));
        await recordAccess({
          userId: ctx.user.id,
          action: "report.addendum",
          studyId: report.studyId,
          detail: `report ${report.id}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { success: true };
      }),

    // URL signée du PDF (lecture). Renvoie null si pas encore généré/signé.
    pdfUrl: medicalProcedure
      .input(z.object({ reportId: z.number() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return { url: null };
        const rows = await db
          .select()
          .from(reports)
          .where(eq(reports.id, input.reportId))
          .limit(1);
        const key = rows[0]?.pdfStorageKey;
        if (!key) return { url: null };
        return { url: await storageGetSignedUrl(key) };
      }),
  }),

  ai: router({
    // Chat « Hermès radiologue » : assistant conversationnel sur l'étude courante.
    // medicalProcedure (rôle clinique) + anti-IDOR (studyId résolu serveur) +
    // rate-limit + PHI local par défaut (Claude seulement sous garde H4).
    askHermes: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string().min(1).max(4000),
              })
            )
            .min(1)
            .max(24),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return runHermesChat(input, {
          user: { id: ctx.user.id },
          req: { ip: ctx.req?.ip },
        });
      }),
    // État du GPU vision (prêt / en veille / en réveil) pour piloter le bouton
    // « Réveiller l'IA ». Lecture seule, rôle clinique.
    gpuStatus: medicalProcedure.query(async () => {
      const { gpuStatus } = await import("./report/gpuControl");
      return gpuStatus();
    }),
    // Réveille le GPU vision (sort de veille). Déclenché par le bouton dédié.
    gpuWake: medicalProcedure.mutation(async () => {
      const { gpuWake } = await import("./report/gpuControl");
      return gpuWake();
    }),

    // --- IA CERTIFIÉE (dispositifs médicaux CE/FDA tiers) -------------------
    // Inventaire des moteurs certifiés branchables (configurés ou non) — pour
    // afficher dans l'UI ce qui est disponible et ce qui est actif.
    certifiedAiInventory: medicalProcedure.query(async () => {
      const { certifiedAiInventory } = await import("./report/externalAI");
      return certifiedAiInventory();
    }),
    // Lance une analyse par un moteur CERTIFIÉ pour la modalité de l'étude.
    // Renvoie { available:false } si aucun fournisseur certifié n'est branché
    // (cas par défaut tant qu'aucun contrat n'est signé) → l'UI propose alors
    // uniquement l'aide interne (Claude/Ollama, non certifiée). La modalité et
    // le StudyInstanceUID sont résolus SERVEUR (la DB les a déjà) pour ne pas
    // dépendre du client.
    certifiedAnalysis: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          seriesId: z.number().int().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { runCertifiedAnalysis } = await import("./report/externalAI");
        const { getStudyById } = await import("./db");
        const study: any = await getStudyById(input.studyId);
        if (!study) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        }
        const rawMod = (study.modality ?? "").trim().toUpperCase();
        // Normalise les modalités DICOM radio vers notre enum XR.
        const modality = (
          ["CR", "DX", "DR", "RX"].includes(rawMod) ? "XR" : rawMod
        ) as "XR" | "CT" | "MR" | "US" | "MG" | "PT" | "NM";
        const studyInstanceUid =
          study.studyInstanceUid ?? study.studyInstanceUID ?? "";
        const result = await runCertifiedAnalysis({
          studyId: input.studyId,
          seriesId: input.seriesId,
          modality,
          studyInstanceUid,
        });
        return result
          ? { available: true as const, result }
          : { available: false as const, modality };
      }),
    // --- Mode validation IA -------------------------------------------------
    // Verdict du médecin sur le brouillon IA d'une étude (juste/partielle/fausse
    // + anomalie ratée). La lecture humaine = vérité ; sert à mesurer l'accord.
    recordEvaluation: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          verdict: z.enum(["juste", "partielle", "fausse"]),
          missedFinding: z.boolean().default(false),
        })
      )
      .mutation(async ({ input }) => {
        const { recordAiVerdict, getStudyById } = await import("./db");
        // Garde : l'étude doit exister (cohérent avec aiPreanalysis). Mono-tenant
        // → tout le personnel clinique accède à toutes les études de l'institut ;
        // pas de propriété d'étude par utilisateur (modèle d'autorisation global).
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        await recordAiVerdict(input);
        return { ok: true };
      }),
    // Verdict déjà saisi pour une étude (pour pré-cocher l'UI).
    evaluation: medicalProcedure
      .input(z.object({ studyId: z.number().int() }))
      .query(async ({ input }) => {
        const { getAiEvaluation } = await import("./db");
        const e = await getAiEvaluation(input.studyId);
        return e
          ? { verdict: e.verdict, missedFinding: e.missedFinding }
          : { verdict: null, missedFinding: false };
      }),
    // Statistiques d'accord IA mesurées sur les examens évalués.
    evaluationStats: medicalProcedure.query(async () => {
      const { getAiEvaluationStats } = await import("./db");
      return getAiEvaluationStats();
    }),
    // Segmentation CT open-source (TotalSegmentator) auto-hébergée sur le GPU :
    // renvoie les structures anatomiques + volumes. Anti-IDOR (série ∈ étude).
    // NON certifié → aide à valider par le médecin.
    segmentCt: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          seriesId: z.number().int(),
          highRes: z.boolean().optional(),
          task: z
            .enum([
              "total",
              "total_mr",
              "head_glands_cavities",
              "headneck_bones_vessels",
              "brain_structures",
            ])
            .optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { getStudyById, listSeriesByStudy } = await import("./db");
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        const series = await listSeriesByStudy(input.studyId);
        if (!series.some((s: any) => s.id === input.seriesId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Série inconnue pour cette étude",
          });
        }
        const { segmentCtSeries } = await import("./report/ctSegmentation");
        return segmentCtSeries(input.seriesId, {
          highRes: input.highRes,
          overlayCount: 6,
          task: input.task,
        });
      }),
    // Analyse EXHAUSTIVE (toutes les coupes) — tâche de fond longue (~10-15 min).
    // Retourne un jobId à sonder via exhaustiveStatus. Anti-IDOR (série ∈ étude).
    startExhaustive: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          seriesId: z.number().int(),
          windowCenter: z.number().optional(),
          windowWidth: z.number().optional(),
          indication: z.string().max(5000).optional(),
          antecedents: z.string().max(5000).optional(),
          // Balayer TOUTES les séries diagnostiques du dossier (pas qu'une).
          wholeStudy: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { getStudyById, listSeriesByStudy } = await import("./db");
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        const series = await listSeriesByStudy(input.studyId);
        if (!series.some((s: any) => s.id === input.seriesId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Série inconnue pour cette étude",
          });
        }
        const { startExhaustiveJob } = await import(
          "./report/exhaustivePreanalysis"
        );
        return startExhaustiveJob({
          studyId: input.studyId,
          seriesId: input.seriesId,
          windowCenter: input.windowCenter ?? 40,
          windowWidth: input.windowWidth ?? 400,
          indication: input.indication,
          antecedents: input.antecedents,
          wholeStudy: input.wholeStudy,
        });
      }),
    exhaustiveStatus: medicalProcedure
      .input(z.object({ jobId: z.string() }))
      .query(async ({ input }) => {
        const { getExhaustiveJob } = await import(
          "./report/exhaustivePreanalysis"
        );
        return getExhaustiveJob(input.jobId);
      }),
    // Suggestion de codes CIM-10 depuis le compte rendu (LLM texte local).
    // SUGGESTION à valider ; la facturation réelle reste dans MediAdmin.
    suggestCodes: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          resultats: z.string().max(20000),
          conclusion: z.string().max(20000),
        })
      )
      .mutation(async ({ input }) => {
        const { getStudyById } = await import("./db");
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        const { suggestCodes } = await import("./report/suggestCodes");
        const { runAgentTool } = await import("./agents/tools");
        const { logAgentActivity } = await import("./agents/state");
        const res = await runAgentTool(
          "codage",
          "suggestBillingCodes",
          () => suggestCodes(input.resultats, input.conclusion),
          null
        );
        await logAgentActivity("codage", "suggestBillingCodes", "ok", {
          detail: `cim=${res.codes.length} tardoc=${res.tardoc.length}`,
        });
        return res;
      }),
    // Dictée vocale → texte (Whisper sur GPU suisse, PHI-safe). Audio en base64.
    transcribe: medicalProcedure
      .input(
        z.object({
          audioBase64: z.string().min(1).max(30_000_000),
          mimeType: z.string().max(100),
          lang: z.string().max(8).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { transcribeAudio } = await import("./report/transcribe");
        return transcribeAudio(input.audioBase64, input.mimeType, input.lang);
      }),
  }),
  knowledge: router({
    // Ingestion de fichiers .md (coffre Obsidian) → chunks + embeddings locaux + stockage.
    ingest: adminProcedure
      .input(
        z.object({
          files: z
            .array(
              z.object({
                name: z.string().min(1).max(512),
                content: z.string().max(2_000_000),
              })
            )
            .min(1)
            .max(50),
        })
      )
      .mutation(async ({ input }) => {
        let inserted = 0;
        const errors: string[] = [];
        for (const f of input.files) {
          try {
            const chunks = chunkMarkdown(f.name, f.content);
            const rows: {
              source: string;
              heading: string;
              content: string;
              embedding: number[];
            }[] = [];
            for (const c of chunks) {
              try {
                const embedding = await embedText(
                  `${c.heading}\n${c.content}`.trim()
                );
                rows.push({ ...c, embedding });
              } catch {
                errors.push(`${f.name}: embedding échoué (chunk)`);
              }
            }
            inserted += await insertChunks(rows);
          } catch {
            errors.push(`${f.name}: ingestion échouée`);
          }
        }
        return { inserted, errors };
      }),
    syncVaultFromDisk: adminProcedure.mutation(async ({ ctx }) => {
      const { syncVault } = await import("./knowledge/vaultSync");
      const { ENV } = await import("./_core/env");
      if (!ENV.knowledgeVaultDir) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "KNOWLEDGE_VAULT_DIR non configuré",
        });
      }
      const result = await syncVault(ENV.knowledgeVaultDir);
      await recordAccess({
        userId: ctx.user.id,
        action: "knowledge.syncVault",
        studyId: null,
        detail: `chunks=${result.chunks} removed=${result.removed}`,
        ipAddress: ctx.req?.ip ?? null,
      });
      return result;
    }),
    // Recherche par similarité (test/2c).
    search: adminProcedure
      .input(
        z.object({
          query: z.string().min(1).max(2000),
          k: z.number().int().min(1).max(20).default(5),
        })
      )
      .mutation(async ({ input }) => {
        const emb = await embedText(input.query);
        return { results: await searchSimilar(emb, input.k) };
      }),
    // Recherche de connaissances exposée au radiologue (lecture seule).
    searchPublic: medicalProcedure
      .input(
        z.object({
          query: z.string().min(1).max(2000),
          k: z.number().int().min(1).max(20).default(8),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const recent = await countRecentAccess(
          ctx.user.id,
          "knowledge.search",
          60
        );
        if (recent >= 120) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Trop de recherches, réessayez plus tard.",
          });
        }
        const emb = await embedText(input.query);
        const hits = await searchSimilar(emb, input.k);
        // Recherche directe : on garde tous les résultats au-dessus du seuil
        // (jusqu'à k), pas la borne d'injection LLM (top-4).
        const results = selectRelevant(hits, { maxChunks: input.k });
        await recordAccess({
          userId: ctx.user.id,
          action: "knowledge.search",
          studyId: null,
          detail: `q.len=${input.query.length}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { results };
      }),
    stats: adminProcedure.query(async () => knowledgeStats()),
    clear: adminProcedure
      .input(z.object({ source: z.string().max(512).optional() }))
      .mutation(async ({ input }) => {
        await clearKnowledge(input.source);
        return { ok: true };
      }),
    // Statut du coffre Obsidian (chemin configuré + nb de .md), sans embedder.
    vaultStatus: adminProcedure.query(async () => {
      const dir = ENV.knowledgeVaultDir;
      if (!dir)
        return { dir: "", configured: false, exists: false, fileCount: 0 };
      const files = await listVaultMarkdown(dir);
      return {
        dir,
        configured: true,
        exists: files.length > 0,
        fileCount: files.length,
      };
    }),
    // Synchronise le coffre Obsidian dédié → base RAG (chunks + embeddings locaux).
    syncVault: adminProcedure.mutation(async ({ ctx }) => {
      const result = await syncVault(ENV.knowledgeVaultDir);
      await recordAccess({
        userId: ctx.user.id,
        action: "knowledge.vault_sync",
        studyId: null,
        detail: `files=${result.files} chunks=${result.chunks} removed=${result.removed}`,
        ipAddress: ctx.req?.ip ?? null,
      });
      return result;
    }),
  }),
  // Détecteur d'IA radiologique CERTIFIÉ CE (deepc/Incepto/Blackford) — aide à la
  // détection (fracture, nodule, hémorragie). Désactivé tant que non configuré (ENV).
  detectors: router({
    status: medicalProcedure.query(async () => {
      const { detectorConfigured } = await import("./report/detectors");
      return {
        configured: detectorConfigured(),
        provider: ENV.detectorProvider || "",
        certified: ENV.detectorProvider === "http",
      };
    }),
    analyze: medicalProcedure
      .input(
        z.object({
          studyId: z.number().int(),
          seriesId: z.number().int().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getStudyById, listSeriesByStudy } = await import("./db");
        const study = await getStudyById(input.studyId);
        if (!study)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Étude introuvable",
          });
        if (input.seriesId !== undefined) {
          const series = await listSeriesByStudy(input.studyId);
          if (!series.some((s: any) => s.id === input.seriesId)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Série inconnue pour cette étude",
            });
          }
        }
        const { analyzeStudyWithDetector } = await import("./report/detectors");
        const result = await analyzeStudyWithDetector(
          input.studyId,
          input.seriesId
        );
        await recordAccess({
          userId: ctx.user.id,
          action: "detectors.analyze",
          studyId: input.studyId,
          detail: `provider=${result.provider} findings=${result.findings.length}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return result;
      }),
  }),
  // Agent CR autonome : réglages + statut (incrément 1).
  agent: router({
    status: medicalProcedure.query(async () => {
      const {
        getAgentSettings,
        countAiReportsSince,
        countPendingSignatureReports,
      } = await import("./db");
      const s = await getAgentSettings();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      return {
        enabled: s?.enabled ?? false,
        enabledAt: s?.enabledAt ?? null,
        dailyCap: s?.dailyCap ?? 20,
        generatedToday: await countAiReportsSince(startOfToday),
        pendingCount: await countPendingSignatureReports(),
      };
    }),
    configure: adminProcedure
      .input(
        z.object({
          enabled: z.boolean().optional(),
          dailyCap: z.number().int().min(1).max(500).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { updateAgentSettings } = await import("./db");
        await updateAgentSettings(input);
        await recordAccess({
          userId: ctx.user.id,
          action: "agent.configure",
          studyId: null,
          detail: `enabled=${input.enabled} cap=${input.dailyCap}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
  }),
  hermes: router({
    findPatientReport: medicalProcedure
      .input(z.object({ query: z.string().min(1).max(120) }))
      .query(async ({ input, ctx }) => {
        const { searchPatientsByName } = await import("./db");
        const results = await searchPatientsByName(input.query);
        await recordAccess({
          userId: ctx.user.id,
          action: "hermes.find",
          studyId: null,
          detail: `n=${results.length}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { results };
      }),
    backfillNameSearch: adminProcedure.mutation(async () => {
      const { backfillPatientNameSearch } = await import("./db");
      return { updated: await backfillPatientNameSearch() };
    }),
    searchVault: medicalProcedure
      .input(z.object({ query: z.string().min(1).max(500) }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { searchVaultFn } = await import("./tools/vaultTools");
        return runAgentTool("copilote", "searchVault", searchVaultFn, {
          query: input.query,
        });
      }),
  }),
  agentsRegistry: router({
    list: medicalProcedure.query(async () => {
      const { AGENTS } = await import("./agents/registry");
      const { getAgentState } = await import("./agents/state");
      const { computeAgentKpis } = await import("./agents/metrics");
      const out = [];
      for (const spec of AGENTS) {
        const state = await getAgentState(spec.key);
        const kpis = await computeAgentKpis(spec.key);
        out.push({ spec, state, kpis });
      }
      return { agents: out };
    }),
    configure: adminProcedure
      .input(
        z.object({
          agentKey: z.string().max(64),
          enabled: z.boolean().optional(),
          targetsJson: z.string().max(4000).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { setAgentState } = await import("./agents/state");
        await setAgentState(input.agentKey, {
          enabled: input.enabled,
          targetsJson: input.targetsJson,
        });
        await recordAccess({
          userId: ctx.user.id,
          action: "agents.configure",
          studyId: null,
          detail: input.agentKey,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
    activity: medicalProcedure
      .input(
        z.object({
          agentKey: z.string().max(64).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
      )
      .query(async ({ input }) => {
        const { listAgentActivity } = await import("./agents/state");
        return { items: await listAgentActivity(input.agentKey, input.limit) };
      }),
    suggestions: medicalProcedure.query(async () => {
      const { getDb } = await import("./db");
      const { agentSuggestions } = await import("../drizzle/schema");
      const { eq, desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { items: [] };
      const items = await db
        .select()
        .from(agentSuggestions)
        .where(eq(agentSuggestions.status, "open"))
        .orderBy(desc(agentSuggestions.createdAt));
      return { items };
    }),
    refreshSuggestions: adminProcedure.mutation(async () => {
      const { AGENTS } = await import("./agents/registry");
      const { computeSuggestions } = await import("./agents/improve");
      let created = 0;
      for (const a of AGENTS) created += await computeSuggestions(a.key);
      return { created };
    }),
    runLearning: adminProcedure.mutation(async ({ ctx }) => {
      const { runLearningAgent } = await import("./agents/learning");
      const res = await runLearningAgent();
      await recordAccess({
        userId: ctx.user.id,
        action: "agents.runLearning",
        studyId: null,
        detail: `proposed=${res.proposed}`,
        ipAddress: ctx.req?.ip ?? null,
      });
      return res;
    }),
    resolveSuggestion: adminProcedure
      .input(
        z.object({
          id: z.number().int(),
          action: z.enum(["approved", "dismissed"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { agentSuggestions } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db
          .update(agentSuggestions)
          .set({ status: input.action })
          .where(eq(agentSuggestions.id, input.id));
        await recordAccess({
          userId: ctx.user.id,
          action: "agents.resolveSuggestion",
          studyId: null,
          detail: `${input.id}:${input.action}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        if (input.action === "approved") {
          const { applyRagFiche } = await import("./agents/learning");
          await applyRagFiche(input.id); // no-op si la suggestion n'est pas une rag_fiche
        }
        return { ok: true };
      }),
  }),
  referringContacts: router({
    resolve: medicalProcedure
      .input(z.object({ name: z.string().max(256) }))
      .query(async ({ input }) => {
        const { resolveReferringEmail } = await import("./db");
        return { email: await resolveReferringEmail(input.name) };
      }),
    upsert: adminProcedure
      .input(
        z.object({
          name: z.string().min(1).max(256),
          email: z.string().email(),
        })
      )
      .mutation(async ({ input }) => {
        const { upsertReferringEmail } = await import("./db");
        await upsertReferringEmail(input.name, input.email);
        return { ok: true };
      }),
    list: medicalProcedure.query(async () => {
      const { listReferringContacts } = await import("./db");
      return { items: await listReferringContacts() };
    }),
    delete: adminProcedure
      .input(z.object({ id: z.number().int() }))
      .mutation(async ({ input, ctx }) => {
        const { deleteReferringContact } = await import("./db");
        await deleteReferringContact(input.id);
        await recordAccess({
          userId: ctx.user.id,
          action: "referent.deleteContact",
          studyId: null,
          detail: `id=${input.id}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
