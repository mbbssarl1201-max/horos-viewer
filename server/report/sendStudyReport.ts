import { TRPCError } from "@trpc/server";
import {
  getStudyById,
  listSeriesByStudy,
  listInstancesBySeries,
  countRecentAccess,
  recordAccess,
  getReportByStudy,
  getUserById,
} from "../db";
import { storageGetBuffer } from "../storage";
import { sendEmail } from "../email";
import { renderDicomFrame } from "./dicomRaster";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";
import { logger } from "../_core/logger";
import { captureException } from "../_core/sentry";
import { buildReportPdf } from "./reportPdf";
import { ENV } from "../_core/env";
import { isAllowedPhiRecipientStrict } from "../_core/emailAllowList";

const MAX_VIDEO_FRAMES = 400;
const CINE_FPS = 12;

export interface SendStudyReportInput {
  to: string;
  studyId: number;
  seriesId: number;
  // Ces champs sont conservés pour la compat de l'input mais IGNORÉS côté
  // serveur : le contenu et la signature sont désormais serveur-autoritatifs
  // (lus depuis le compte-rendu signé en DB). Cf. audit I1.
  report?: {
    indication: string;
    technique: string;
    resultats: string;
    conclusion: string;
  };
  signature?: string;
  windowCenter: number;
  windowWidth: number;
  keyImages: Array<{
    pngBase64: string;
    sliceIndex: number;
    measurements?: string;
  }>;
  includeVideo: boolean;
  message?: string;
  // Ignoré côté serveur : aiAssisted est lu depuis report.aiGenerated. Cf. I1.
  aiAssisted?: boolean;
  antecedents?: string;
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

  // Allow-list de domaines destinataires (egress PHI). Fail-closed (audit B-4) :
  // en prod, une liste vide REFUSE tout envoi tant que REPORT_EMAIL_ALLOWED_DOMAINS
  // n'est pas renseigné (au lieu du fail-open historique). Cf. I-email.
  if (
    !isAllowedPhiRecipientStrict(
      input.to,
      ENV.reportEmailAllowedDomains,
      ENV.isProduction
    )
  )
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        ENV.isProduction && ENV.reportEmailAllowedDomains.length === 0
          ? "Envoi PHI désactivé : REPORT_EMAIL_ALLOWED_DOMAINS non configuré."
          : "Destinataire non autorisé (domaine non whitelisté).",
    });

  const series = await listSeriesByStudy(input.studyId);
  if (!series.some((s: any) => s.id === input.seriesId))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Série inconnue pour cette étude",
    });

  // Verrou médico-légal (audit I1) : on ne peut emailer un CR que s'il existe
  // un compte-rendu SIGNÉ pour l'étude. Le contenu et la signature sont
  // serveur-autoritatifs (lus en DB), jamais issus de l'input client.
  const report = await getReportByStudy(input.studyId);
  if (!report || report.status !== "signed")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Le compte-rendu doit être signé avant l'envoi.",
    });

  input.keyImages.forEach(k => assertPng(k.pngBase64));

  const signer = report.signedBy
    ? await getUserById(report.signedBy)
    : undefined;
  const signedAtStr = report.signedAt
    ? new Date(report.signedAt).toLocaleString("fr-CH")
    : "";
  const signature = `Signé par ${signer?.name ?? signer?.email ?? "Dr"}${
    signedAtStr ? ` le ${signedAtStr}` : ""
  }`;

  const pdf = buildReportPdf({
    study,
    report: {
      indication: report.indication ?? "",
      technique: report.technique ?? "",
      resultats: report.resultats ?? "",
      conclusion: report.conclusion ?? "",
    },
    signature,
    keyImages: input.keyImages,
    aiAssisted: report.aiGenerated,
    antecedents: input.antecedents,
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

  // Lien de consultation en ligne — RÉSERVÉ au personnel MediView authentifié
  // (7 j, usage unique). Les destinataires externes s'appuient sur le PDF joint.
  // Non-bloquant si échec.
  let otpBlock = "";
  try {
    const { createShareToken } = await import("./reportShareToken");
    const reportRow = await getReportByStudy(study.id);
    if (reportRow) {
      const token = await createShareToken(reportRow.id, study.id, input.to);
      const base = process.env.APP_BASE_URL ?? "https://mediview.ch";
      const url = `${base}/r/${token}`;
      otpBlock =
        `<p style="margin:16px 0">` +
        `<a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;` +
        `padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">` +
        `Ouvrir l'imagerie dans MediView →</a></p>` +
        `<p style="color:#999;font-size:11px">Lien valable 7 jours · usage unique · ` +
        `réservé aux professionnels disposant d'un accès MediView (connexion requise). ` +
        `Le compte rendu complet est joint en PDF.</p>`;
    }
  } catch {
    /* best-effort */
  }

  const result = await sendEmail({
    to: input.to,
    // Sujet NON nominatif (le PDF joint reste nominatif). Cf. I-email.
    subject: `Compte rendu d'imagerie — étude #${study.id}`,
    html:
      `<div style="font-family:sans-serif;max-width:600px">` +
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver ci-joint le compte rendu d'imagerie (PDF)` +
      (input.includeVideo ? ` et le ciné de la série (MP4)` : ``) +
      `.</p>` +
      (safeMsg ? `<p>${safeMsg}</p>` : "") +
      otpBlock +
      `<p style="color:#888;font-size:12px">Document médical confidentiel — destiné au seul destinataire.</p>` +
      `</div>`,
    attachments,
  });

  if (!result.success) {
    const err = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: result.error || "Échec d'envoi de l'email",
    });
    logger.error("report.send_failed", {
      studyId: input.studyId,
      error: result.error ?? "unknown",
    });
    captureException(err);
    throw err;
  }
  return { success: true };
}
