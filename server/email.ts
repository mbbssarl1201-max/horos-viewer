/**
 * Email Notification Service
 * Sends email notifications for:
 * - New study received
 * - STAT/urgent study
 * - Report finalized
 */
import nodemailer from "nodemailer";
import { ENV } from "./_core/env";

interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/**
 * Escape a value before interpolating it into an HTML email body, so
 * attacker-controlled fields (patient name, urgency reason, …) cannot inject
 * markup or scripts into the rendered message.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Create a configured SMTP transporter
 */
function createTransporter() {
  if (!ENV.smtpHost || !ENV.smtpUser) {
    return null;
  }

  return nodemailer.createTransport({
    host: ENV.smtpHost,
    port: ENV.smtpPort,
    secure: ENV.smtpPort === 465,
    auth: {
      user: ENV.smtpUser,
      pass: ENV.smtpPassword,
    },
  });
}

/**
 * Send an email notification
 */
export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; error?: string }> {
  const transporter = createTransporter();

  if (!transporter) {
    console.warn("[Email] SMTP not configured - email not sent:", options.subject);
    return { success: false, error: "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD environment variables." };
  }

  try {
    const recipients = Array.isArray(options.to) ? options.to.join(", ") : options.to;

    await transporter.sendMail({
      from: ENV.smtpFrom,
      to: recipients,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ""),
    });

    console.log("[Email] Sent:", options.subject, "to:", recipients);
    return { success: true };
  } catch (err: any) {
    console.error("[Email] Failed to send:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send notification for new study received
 */
export async function notifyNewStudy(params: {
  recipientEmail: string;
  patientName: string;
  modality: string;
  studyDate: string;
  studyDescription: string;
  institution?: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.recipientEmail,
    subject: `[Horos] New Study Received - ${params.patientName} (${params.modality})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
          <h2 style="color: #4fc3f7; margin-top: 0;">New Study Received</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Patient:</td><td style="padding: 8px 0; color: #fff;">${esc(params.patientName)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Modality:</td><td style="padding: 8px 0; color: #fff;">${esc(params.modality)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Date:</td><td style="padding: 8px 0; color: #fff;">${esc(params.studyDate)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Description:</td><td style="padding: 8px 0; color: #fff;">${esc(params.studyDescription)}</td></tr>
            ${params.institution ? `<tr><td style="padding: 8px 0; color: #9e9e9e;">Institution:</td><td style="padding: 8px 0; color: #fff;">${esc(params.institution)}</td></tr>` : ""}
          </table>
          <p style="margin-top: 20px; font-size: 12px; color: #757575;">This is an automated notification from Horos Medical Imaging Viewer.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send STAT/urgent notification
 */
export async function notifyStatUrgent(params: {
  recipientEmail: string;
  patientName: string;
  modality: string;
  studyDate: string;
  studyDescription: string;
  urgencyReason?: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.recipientEmail,
    subject: `🚨 [STAT/URGENT] ${params.patientName} - ${params.modality} - Immediate Attention Required`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px; border-left: 4px solid #f44336;">
          <h2 style="color: #f44336; margin-top: 0;">⚠️ STAT / URGENT Study</h2>
          <p style="color: #ffcdd2; font-weight: bold;">This study requires immediate attention.</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Patient:</td><td style="padding: 8px 0; color: #fff; font-weight: bold;">${esc(params.patientName)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Modality:</td><td style="padding: 8px 0; color: #fff;">${esc(params.modality)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Date:</td><td style="padding: 8px 0; color: #fff;">${esc(params.studyDate)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Description:</td><td style="padding: 8px 0; color: #fff;">${esc(params.studyDescription)}</td></tr>
            ${params.urgencyReason ? `<tr><td style="padding: 8px 0; color: #9e9e9e;">Reason:</td><td style="padding: 8px 0; color: #f44336; font-weight: bold;">${esc(params.urgencyReason)}</td></tr>` : ""}
          </table>
          <p style="margin-top: 20px; font-size: 12px; color: #757575;">This is an automated STAT notification from Horos Medical Imaging Viewer.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send notification for finalized report
 */
export async function notifyReportFinalized(params: {
  recipientEmail: string;
  patientName: string;
  modality: string;
  studyDate: string;
  reportAuthor: string;
  reportSummary?: string;
}): Promise<{ success: boolean; error?: string }> {
  return sendEmail({
    to: params.recipientEmail,
    subject: `[Horos] Report Finalized - ${params.patientName} (${params.modality})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px; border-left: 4px solid #4caf50;">
          <h2 style="color: #4caf50; margin-top: 0;">✓ Report Finalized</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Patient:</td><td style="padding: 8px 0; color: #fff;">${esc(params.patientName)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Modality:</td><td style="padding: 8px 0; color: #fff;">${esc(params.modality)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Study Date:</td><td style="padding: 8px 0; color: #fff;">${esc(params.studyDate)}</td></tr>
            <tr><td style="padding: 8px 0; color: #9e9e9e;">Author:</td><td style="padding: 8px 0; color: #fff;">${esc(params.reportAuthor)}</td></tr>
            ${params.reportSummary ? `<tr><td style="padding: 8px 0; color: #9e9e9e;">Summary:</td><td style="padding: 8px 0; color: #fff;">${esc(params.reportSummary)}</td></tr>` : ""}
          </table>
          <p style="margin-top: 20px; font-size: 12px; color: #757575;">This is an automated notification from Horos Medical Imaging Viewer.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Check SMTP configuration status
 */
export function getSmtpStatus(): { configured: boolean; host?: string; port?: number } {
  if (!ENV.smtpHost || !ENV.smtpUser) {
    return { configured: false };
  }
  return { configured: true, host: ENV.smtpHost, port: ENV.smtpPort };
}
