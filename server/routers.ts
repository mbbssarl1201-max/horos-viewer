import { COOKIE_NAME } from "@shared/const";
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
import { storagePut } from "./storage";
import { hasMedicalAccess, isAdmin } from "./rbac";
import { checkOrthancConnection, qidoSearchStudies, cFind, cMove, listModalities } from "./orthanc";
import { sendEmail, notifyNewStudy, notifyStatUrgent, notifyReportFinalized, getSmtpStatus } from "./email";

// DICOM Application Entity Title: max 16 chars, no path separators or spaces.
// Constrained here to block path traversal / SSRF when interpolated into the
// Orthanc REST URL (e.g. `/modalities/${aet}/query`).
const aeTitleSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,16}$/, "Invalid AE Title");

/**
 * Anonymize DICOM file buffer by zeroing out PII tags in the binary.
 * This performs a best-effort removal of patient-identifying information
 * from the raw DICOM byte stream before storage on S3.
 */
function anonymizeDicomBuffer(buffer: Buffer): Buffer {
  // DICOM PII tags to anonymize (group, element pairs)
  const PII_TAGS = [
    [0x0010, 0x0010], // PatientName
    [0x0010, 0x0020], // PatientID
    [0x0010, 0x0030], // PatientBirthDate
    [0x0010, 0x0040], // PatientSex
    [0x0010, 0x1000], // OtherPatientIDs
    [0x0010, 0x1001], // OtherPatientNames
    [0x0010, 0x1010], // PatientAge
    [0x0010, 0x1020], // PatientSize
    [0x0010, 0x1030], // PatientWeight
    [0x0010, 0x1040], // PatientAddress
    [0x0010, 0x2154], // PatientTelephoneNumbers
    [0x0008, 0x0050], // AccessionNumber
    [0x0008, 0x0080], // InstitutionName
    [0x0008, 0x0081], // InstitutionAddress
    [0x0008, 0x0090], // ReferringPhysicianName
    [0x0008, 0x1050], // PerformingPhysicianName
  ];

  const result = Buffer.from(buffer);

  // DICOM files start with 128 byte preamble + "DICM" magic
  if (result.length < 132) return result;
  const magic = result.toString("ascii", 128, 132);
  if (magic !== "DICM") return result; // Not a valid DICOM file

  let offset = 132; // Start after preamble + magic

  // Parse data elements and blank PII values
  while (offset < result.length - 8) {
    const group = result.readUInt16LE(offset);
    const element = result.readUInt16LE(offset + 2);

    // Check VR (Value Representation) - explicit VR
    const vr = result.toString("ascii", offset + 4, offset + 6);
    let valueLength: number;
    let valueOffset: number;

    // VRs with 4-byte length field
    if (["OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UN", "UR", "UT"].includes(vr)) {
      if (offset + 12 > result.length) break;
      valueLength = result.readUInt32LE(offset + 8);
      valueOffset = offset + 12;
    } else if (vr.match(/^[A-Z]{2}$/)) {
      // Standard 2-byte length VRs
      valueLength = result.readUInt16LE(offset + 6);
      valueOffset = offset + 8;
    } else {
      // Implicit VR - 4 byte length at offset+4
      valueLength = result.readUInt32LE(offset + 4);
      valueOffset = offset + 8;
    }

    // Undefined length or invalid
    if (valueLength === 0xFFFFFFFF || valueLength < 0) {
      break;
    }

    // Check if this tag is PII
    const isPII = PII_TAGS.some(([g, e]) => g === group && e === element);
    if (isPII && valueOffset + valueLength <= result.length) {
      // Replace value bytes with spaces (0x20) to maintain DICOM structure
      result.fill(0x20, valueOffset, valueOffset + valueLength);
    }

    offset = valueOffset + valueLength;

    // Stop at pixel data
    if (group === 0x7FE0 && element === 0x0010) break;
  }

  return result;
}

// Clinical read/write access to patient data (PHI). Excludes the default
// "user" role: an account must be promoted to a clinical role first.
const medicalProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!hasMedicalAccess(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Clinical role required" });
  }
  return next({ ctx });
});

// Reporting-level actions (admin or radiologist): status, priority, anonymize.
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "radiologist") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin or radiologist access required" });
  }
  return next({ ctx });
});

// Destructive / system actions (delete, C-MOVE exfiltration) — admin only.
const strictAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isAdmin(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Administrator access required" });
  }
  return next({ ctx });
});

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
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
      .input(z.object({ modality: z.string().optional(), timeFilter: z.string().optional() }).optional())
      .query(async ({ input }) => {
        return listStudies({ modality: input?.modality, timeFilter: input?.timeFilter });
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

    updateStatus: adminProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["new", "in_progress", "reported", "finalized"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { studies } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

        await db.update(studies).set({ status: input.status }).where(eq(studies.id, input.id));

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

        return { success: true };
      }),

    updatePriority: adminProcedure
      .input(z.object({
        id: z.number(),
        priority: z.enum(["routine", "stat", "urgent"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { studies } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

        await db.update(studies).set({ priority: input.priority }).where(eq(studies.id, input.id));

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

        return { success: true };
      }),

    anonymize: adminProcedure
      .input(z.object({
        id: z.number(),
        fields: z.array(z.string()),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { studies, patients } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

        const PLACEHOLDER = "[ANONYMIZED]";

        // Patient-identity fields live on the `patients` table; only report
        // metadata lives on `studies`. studies.patientId is an int FK to
        // patients.id, NOT the DICOM identity — never overwrite it here.
        const STUDY_FIELDS = new Set(["referringPhysician", "institution", "accessionNumber"]);
        const PATIENT_FIELDS = new Set(["patientName", "patientId", "birthDate"]);

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
          await db.update(studies).set(studyUpdate).where(eq(studies.id, input.id));
        }

        if (patientCount > 0) {
          // Resolve the linked patient row, then anonymize it. This affects
          // every study of that patient — correct for identity removal.
          const [study] = await db
            .select({ patientId: studies.patientId })
            .from(studies)
            .where(eq(studies.id, input.id))
            .limit(1);
          if (!study) throw new TRPCError({ code: "NOT_FOUND", message: "Study not found" });
          await db.update(patients).set(patientUpdate).where(eq(patients.id, study.patientId));
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
        const { studies, series, instances, annotations, notifications, albumStudies } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

        // Delete child rows (no DB-level cascade), then the study itself,
        // so no annotations / notifications / album links are left orphaned.
        const studySeries = await db.select().from(series).where(eq(series.studyId, input.id));
        for (const s of studySeries) {
          const seriesInstances = await db.select().from(instances).where(eq(instances.seriesId, s.id));
          for (const inst of seriesInstances) {
            await db.delete(annotations).where(eq(annotations.instanceId, inst.id));
          }
          await db.delete(instances).where(eq(instances.seriesId, s.id));
        }
        await db.delete(series).where(eq(series.studyId, input.id));
        await db.delete(notifications).where(eq(notifications.studyId, input.id));
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
      .input(z.object({
        instanceId: z.number(),
        type: z.enum(["length", "angle", "rect_roi", "ellipse_roi", "text"]),
        data: z.any(),
      }))
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

        return db.select().from(annotations).where(eq(annotations.instanceId, input.instanceId));
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
        const studySeries = await db.select().from(series).where(eq(series.studyId, input.studyId));
        const allInstances = [];
        for (const s of studySeries) {
          const seriesInstances = await db.select().from(instances).where(eq(instances.seriesId, s.id));
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
      .input(z.object({
        studyId: z.number(),
        annotations: z.array(z.object({
          type: z.string(),
          label: z.string().optional(),
          value: z.string().optional(),
        })).optional(),
      }))
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
      .input(z.object({
        patientName: z.string().optional(),
        patientId: z.string().optional(),
        studyDate: z.string().optional(),
        modality: z.string().optional(),
        accessionNumber: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        try {
          const results = await qidoSearchStudies(input);
          return { success: true, results };
        } catch (err: any) {
          return { success: false, results: [], error: err.message };
        }
      }),

    cFind: medicalProcedure
      .input(z.object({
        aet: aeTitleSchema,
        level: z.enum(["Study", "Series", "Instance"]),
        query: z.record(z.string(), z.string()),
      }))
      .mutation(async ({ input }) => {
        try {
          const results = await cFind(input);
          return { success: true, results };
        } catch (err) {
          // Don't leak internal Orthanc/error details to the client.
          console.error("cFind failed:", err);
          return { success: false, results: [], error: "C-FIND request failed" };
        }
      }),

    // C-MOVE can exfiltrate whole studies to an arbitrary AET — admin only.
    cMove: strictAdminProcedure
      .input(z.object({
        sourceAet: aeTitleSchema,
        targetAet: aeTitleSchema,
        studyInstanceUID: z.string(),
      }))
      .mutation(async ({ input }) => {
        return cMove(input);
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
      return db.select().from(pacsServers).where(eq(pacsServers.userId, ctx.user.id));
    }),

    // Configuring a PACS endpoint defines where studies can be C-MOVE'd —
    // admin/radiologist only, not every logged-in account.
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        aeTitle: aeTitleSchema,
        host: z.string().min(1),
        port: z.number().min(1).max(65535),
        orthancUrl: z.string().optional(),
      }))
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
        await db.delete(pacsServers).where(and(eq(pacsServers.id, input.id), eq(pacsServers.userId, ctx.user.id)));
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
          subject: "[Horos Viewer] Test Email",
          html: "<p>This is a test email from Horos Medical Imaging Viewer. SMTP is configured correctly.</p>",
        });
      }),

    notifyNewStudy: medicalProcedure
      .input(z.object({
        recipientEmail: z.string().email(),
        patientName: z.string(),
        modality: z.string(),
        studyDate: z.string(),
        studyDescription: z.string(),
        institution: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return notifyNewStudy(input);
      }),

    notifyStatUrgent: medicalProcedure
      .input(z.object({
        recipientEmail: z.string().email(),
        patientName: z.string(),
        modality: z.string(),
        studyDate: z.string(),
        studyDescription: z.string(),
        urgencyReason: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return notifyStatUrgent(input);
      }),

    notifyReportFinalized: medicalProcedure
      .input(z.object({
        recipientEmail: z.string().email(),
        patientName: z.string(),
        modality: z.string(),
        studyDate: z.string(),
        reportAuthor: z.string(),
        reportSummary: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        return notifyReportFinalized(input);
      }),
  }),
});

export type AppRouter = typeof appRouter;
