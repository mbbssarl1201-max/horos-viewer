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
} from "./db";
import { storagePut, storageDelete } from "./storage";
import { hasMedicalAccess, isAdmin } from "./rbac";
import {
  checkOrthancConnection,
  qidoSearchStudies,
  cFind,
  cMove,
  cStoreStudy,
  listModalities,
} from "./orthanc";
import {
  sendEmail,
  notifyNewStudy,
  notifyStatUrgent,
  notifyReportFinalized,
  getSmtpStatus,
} from "./email";
import { ENV } from "./_core/env";
import { shouldNotify, PRIORITY_TRIGGERS, STATUS_TRIGGERS } from "./risNotify";
import { annotationDataSchema } from "./annotationSchema";
import dcmjs from "dcmjs";

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
            modality: z.string().optional(),
            timeFilter: z.string().optional(),
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
        const { getDb } = await import("./db");
        const { studies } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
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
        const { getDb } = await import("./db");
        const { studies } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
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
            // birthDate is varchar(10): the placeholder won't fit, so null it.
            (patientUpdate as Record<string, unknown>)[field] =
              field === "birthDate" ? null : PLACEHOLDER;
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
        await db.delete(studies).where(eq(studies.id, input.id));

        await recordAccess({
          userId: ctx.user.id,
          action: "study.delete",
          studyId: input.id,
          ipAddress: ctx.req?.ip ?? null,
        });

        return { success: true };
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
          fileData: z.string(), // base64 encoded DICOM file
          fileSize: z.number(),
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

  // Orthanc PACS router
  orthanc: router({
    status: medicalProcedure.query(async () => {
      return checkOrthancConnection();
    }),

    modalities: medicalProcedure.query(async () => {
      return listModalities();
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
          query: z.record(z.string(), z.string()),
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
      const { getDb } = await import("./db");
      const { pacsServers } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
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
    sendStudyReport: medicalProcedure
      .input(
        z.object({
          to: z.string().email(),
          studyId: z.number(),
          seriesId: z.number(),
          report: z.object({
            indication: z.string().max(5000),
            technique: z.string().max(5000),
            resultats: z.string().max(20000),
            conclusion: z.string().max(5000),
          }),
          signature: z.string().min(1).max(120),
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
            .min(1)
            .max(20),
          indication: z.string().max(5000).optional(),
          antecedents: z.string().max(5000).optional(),
          // Échantillonnage serveur du volume (analyse de toute la série).
          seriesId: z.number().int().optional(),
          windowCenter: z.number().optional(),
          windowWidth: z.number().optional(),
          sampleCount: z.number().int().min(1).max(24).optional(),
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
      .mutation(async ({ input }) => {
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
      .mutation(async ({ input }) => {
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
      .mutation(async ({ input }) => {
        return notifyReportFinalized(input);
      }),
  }),
});

export type AppRouter = typeof appRouter;
