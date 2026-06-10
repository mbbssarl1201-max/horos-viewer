import { TRPCError } from "@trpc/server";
import {
  getStudyById,
  listSeriesByStudy,
  listInstancesBySeries,
  countRecentAccess,
  recordAccess,
} from "../db";
import { storageGetBuffer } from "../storage";
import { sendEmail } from "../email";
import { renderDicomFrame } from "./dicomRaster";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";
import { buildReportPdf } from "./reportPdf";

const MAX_VIDEO_FRAMES = 400;
const CINE_FPS = 12;

export interface SendStudyReportInput {
  to: string;
  studyId: number;
  seriesId: number;
  report: {
    indication: string;
    technique: string;
    resultats: string;
    conclusion: string;
  };
  signature: string;
  windowCenter: number;
  windowWidth: number;
  keyImages: Array<{
    pngBase64: string;
    sliceIndex: number;
    measurements?: string;
  }>;
  includeVideo: boolean;
  message?: string;
}

function assertPng(b64: string) {
  const png = Buffer.from(b64, "base64");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Image clé : PNG attendu",
    });
  }
}

function subsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

export async function sendStudyReportImpl(
  input: SendStudyReportInput,
  ctx: { user: { id: number }; req?: { ip?: string } }
) {
  const recent = await countRecentAccess(ctx.user.id, "study.email.report", 60);
  if (recent >= 20)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Limite d'envois atteinte, réessayez plus tard.",
    });

  const study = await getStudyById(input.studyId);
  if (!study)
    throw new TRPCError({ code: "NOT_FOUND", message: "Étude introuvable" });

  const series = await listSeriesByStudy(input.studyId);
  if (!series.some((s: any) => s.id === input.seriesId))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Série inconnue pour cette étude",
    });

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  const pdf = buildReportPdf({
    study,
    report: input.report,
    signature: input.signature,
    keyImages: input.keyImages,
  });
  const attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }> = [
    {
      filename: `compte-rendu-${study.id}.pdf`,
      content: pdf,
      contentType: "application/pdf",
    },
  ];

  if (input.includeVideo) {
    if (!ffmpegAvailable())
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Génération vidéo indisponible (ffmpeg)",
      });
    const instances = (await listInstancesBySeries(input.seriesId))
      .slice()
      .sort(
        (a: any, b: any) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)
      );
    if (instances.length >= 2) {
      const chosen = subsample(instances, MAX_VIDEO_FRAMES);
      const frames: Buffer[] = [];
      for (const inst of chosen) {
        const dicom = await storageGetBuffer(inst.storageKey);
        const { png } = renderDicomFrame(dicom, {
          windowCenter: input.windowCenter,
          windowWidth: input.windowWidth,
        });
        frames.push(png);
      }
      const mp4 = await buildCineMp4(frames, { fps: CINE_FPS });
      attachments.push({
        filename: `serie-cine-${study.id}.mp4`,
        content: mp4,
        contentType: "video/mp4",
      });
    }
  }

  const subjectName = study.patientName ? ` — ${study.patientName}` : "";
  const safeMsg = (input.message ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Audit AVANT l'envoi : on trace l'egress PHI tenté quoi qu'il advienne du
  // transport email (si recordAccess était après sendEmail, un envoi réussi
  // suivi d'un échec d'écriture d'audit laisserait l'egress non tracé).
  await recordAccess({
    userId: ctx.user.id,
    action: "study.email.report",
    studyId: study.id,
    detail: input.to,
    ipAddress: ctx.req?.ip ?? null,
  });

  const result = await sendEmail({
    to: input.to,
    subject: `Compte rendu d'imagerie${subjectName}`,
    html:
      `<div style="font-family:sans-serif;max-width:600px">` +
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver ci-joint le compte rendu d'imagerie (PDF)` +
      (input.includeVideo ? ` et le ciné de la série (MP4)` : ``) +
      `.</p>` +
      (safeMsg ? `<p>${safeMsg}</p>` : "") +
      `<p style="color:#888;font-size:12px">Document médical confidentiel — destiné au seul destinataire.</p>` +
      `</div>`,
    attachments,
  });

  if (!result.success)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: result.error || "Échec d'envoi de l'email",
    });
  return { success: true };
}
