import { eq } from "drizzle-orm";
import { getDb, getStudyById, recordAccess } from "../db";
import { construireColis, creerJeton } from "./bundle";
import { sendEmail } from "../email";
import { buildStudyExportPdf } from "../report/reportPdf";
import {
  isAllowedPhiRecipientStrict,
  isAllowedRecipient,
} from "../_core/emailAllowList";
import { ENV } from "../_core/env";
import { insurerRequests } from "../../drizzle/schema";
import type { ExtractionDemande } from "./types";

const QUINZE_MO = 15 * 1024 * 1024;

/**
 * Échappe une valeur avant interpolation HTML (mail assureur) — mêmes règles
 * que `esc()` de `server/email.ts` (copie locale, pas d'export partagé pour
 * ne pas élargir la surface d'un module consommé par d'autres features).
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
 * Décide si une demande d'imagerie assureur peut être envoyée AUTOMATIQUEMENT,
 * sans validation humaine. Fonction PURE : les 4 conditions ci-dessous doivent
 * TOUTES être réunies :
 *  1. expéditeur de la demande dans la liste des émetteurs de confiance ;
 *  2. patient identifié avec CERTITUDE dans MediView (statut "exact") ;
 *  3. tous les examens demandés retrouvés, à la date EXACTE (pas approchée) ;
 *  4. adresse de réponse présente et dans un domaine autorisé pour l'auto-envoi.
 * `motifs` détaille en français chaque condition manquante — affiché tel quel
 * dans l'UI de validation humaine et dans le mail de notification.
 */
export function decideEnvoiAuto(args: {
  expediteur: string;
  matchPatientStatut: "exact" | "ambigu" | "aucun";
  tousTrouves: boolean;
  datesExactes: boolean;
  adresseReponse: string | null;
  env: { trustedSenders: string[]; autoSendDomains: string[] };
}): { auto: boolean; motifs: string[] } {
  const motifs: string[] = [];

  const expediteurNorm = args.expediteur.trim().toLowerCase();
  const expediteurConnu = args.env.trustedSenders
    .map(s => s.trim().toLowerCase())
    .includes(expediteurNorm);
  if (!expediteurConnu) {
    motifs.push("Expéditeur non reconnu comme émetteur de confiance");
  }

  if (args.matchPatientStatut !== "exact") {
    motifs.push(
      args.matchPatientStatut === "ambigu"
        ? "Identification du patient ambiguë (plusieurs correspondances possibles)"
        : "Patient non identifié avec certitude dans MediView"
    );
  }

  if (!args.tousTrouves) {
    motifs.push("Au moins un examen demandé n'a pas été retrouvé");
  }

  if (!args.datesExactes) {
    motifs.push(
      "Date d'au moins un examen non exactement concordante (date rapprochée)"
    );
  }

  if (!args.adresseReponse) {
    motifs.push("Adresse de réponse absente de la demande");
  } else if (
    !isAllowedRecipient(args.adresseReponse, args.env.autoSendDomains)
  ) {
    motifs.push(
      "Domaine de l'adresse de réponse non autorisé pour l'envoi automatique"
    );
  }

  return { auto: motifs.length === 0, motifs };
}

/** Récap HTML (liste) des examens demandés, tel que lu par l'extraction LLM. */
function recapExamensHtml(exams: ExtractionDemande["exams"]): string {
  if (!exams.length) return "<li>Aucun examen listé</li>";
  return exams
    .map(e => {
      const desc = e.description || e.modalite || "Examen";
      const date = e.dateDemandee ? ` — ${e.dateDemandee}` : "";
      return `<li>${esc(desc)}${esc(date)}</li>`;
    })
    .join("");
}

/**
 * Construit un CR PDF par étude (métadonnées, cf. `buildStudyExportPdf`) pour
 * une éventuelle pièce jointe directe — en plus du colis ZIP qui contient déjà
 * les mêmes CR (cf. `construireColis`). Best-effort : une étude/CR
 * indisponible est ignorée sans bloquer l'envoi.
 */
async function buildCrAttachments(
  studyIds: number[]
): Promise<{ filename: string; content: Buffer; contentType: string }[]> {
  const out: { filename: string; content: Buffer; contentType: string }[] = [];
  for (const studyId of studyIds) {
    const study = await getStudyById(studyId);
    if (!study) continue;
    try {
      const pdf = buildStudyExportPdf(study);
      out.push({
        filename: `CR-etude-${studyId}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      });
    } catch {
      /* CR indisponible pour cette étude : on continue sans bloquer l'envoi */
    }
  }
  return out;
}

/**
 * Envoie la réponse (colis DICOM+CR) d'une demande assureur : construit le
 * colis et son jeton de téléchargement (Task 5), compose le mail FR (récap
 * examens, lien de téléchargement, mention d'expiration), passe la garde
 * egress PHI, envoie, transitionne le statut de la demande et journalise
 * l'envoi dans `access_logs`. `opts.valideParUserId` est absent pour un envoi
 * AUTOMATIQUE (décidé par `decideEnvoiAuto` en amont) et renseigné pour un
 * envoi validé par un humain.
 */
export async function envoyerReponse(
  requestId: number,
  opts: { valideParUserId?: number }
): Promise<{ success: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { success: false, error: "Base de données indisponible" };

  const rows = await db
    .select()
    .from(insurerRequests)
    .where(eq(insurerRequests.id, requestId))
    .limit(1);
  const row = rows[0];
  if (!row) return { success: false, error: "Demande introuvable" };

  const studyIds = row.studyIds ?? [];
  const extraction = (row.extraction as ExtractionDemande | null) ?? null;
  const adresseReponse = row.adresseReponse;

  const echouer = async (motif: string) => {
    try {
      await db
        .update(insurerRequests)
        .set({ statut: "erreur", erreur: motif })
        .where(eq(insurerRequests.id, requestId));
    } catch {
      /* best-effort : le motif d'origine reste la valeur de retour */
    }
    return { success: false as const, error: motif };
  };

  if (!adresseReponse) {
    return echouer("Adresse de réponse absente de la demande");
  }
  if (!studyIds.length) {
    return echouer("Aucune étude à transmettre");
  }

  // Garde egress PHI (audit I-email) : fail-closed en production si aucun
  // domaine n'est whitelisté, quel que soit le destinataire.
  if (
    !isAllowedPhiRecipientStrict(
      adresseReponse,
      ENV.reportEmailAllowedDomains,
      ENV.isProduction
    )
  ) {
    return echouer(
      ENV.isProduction && ENV.reportEmailAllowedDomains.length === 0
        ? "Envoi PHI désactivé : REPORT_EMAIL_ALLOWED_DOMAINS non configuré."
        : "Destinataire non autorisé (domaine non whitelisté)."
    );
  }

  const { bundleKey, tailleOctets } = await construireColis(
    requestId,
    studyIds
  );
  const { tokenClair } = await creerJeton(requestId, bundleKey);

  const base = process.env.APP_BASE_URL ?? "https://mediview.ch";
  const lien = `${base}/dl/${tokenClair}`;

  const crAttachments = await buildCrAttachments(studyIds);
  const totalCrOctets = crAttachments.reduce((s, a) => s + a.content.length, 0);
  const inclureCrEnPJ = crAttachments.length > 0 && totalCrOctets < QUINZE_MO;

  const exams = extraction?.exams ?? [];
  const refSinistre = extraction?.refSinistre ?? null;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 8px;">
        <h2 style="color: #4fc3f7; margin-top: 0;">Réponse à votre demande d'imagerie</h2>
        ${refSinistre ? `<p style="color:#9e9e9e;">Référence sinistre : <span style="color:#fff;">${esc(refSinistre)}</span></p>` : ""}
        <p style="color:#fff;">Examens transmis :</p>
        <ul style="color:#fff;">${recapExamensHtml(exams)}</ul>
        <p style="color:#fff;">
          Le colis complet (images DICOM${inclureCrEnPJ ? "" : " et compte-rendu"})
          est disponible via le lien sécurisé suivant :
        </p>
        <p><a href="${esc(lien)}" style="color:#4fc3f7;">${esc(lien)}</a></p>
        <p style="color:#ffcdd2;">Ce lien expire automatiquement 14 jours après son émission.</p>
        ${
          inclureCrEnPJ
            ? `<p style="color:#fff;">Le compte-rendu radiologique est joint à ce message.</p>`
            : `<p style="color:#fff;">Le compte-rendu radiologique est inclus dans le colis téléchargeable ci-dessus (fichier trop volumineux pour être joint directement).</p>`
        }
        <p style="margin-top: 20px; font-size: 12px; color: #757575;">Ceci est un message automatisé de MediView.</p>
      </div>
    </div>
  `;

  const result = await sendEmail({
    to: adresseReponse,
    subject: "[MediView] Réponse à votre demande d'imagerie",
    html,
    attachments: inclureCrEnPJ ? crAttachments : undefined,
  });

  if (!result.success) {
    return echouer(result.error || "Échec de l'envoi du courriel");
  }

  const envoyePar = opts.valideParUserId ?? null;
  await db
    .update(insurerRequests)
    .set({ statut: "envoyee", envoyeLe: new Date(), envoyePar })
    .where(eq(insurerRequests.id, requestId));

  // userId 0 = agent système (envoi automatique, sans validateur humain) —
  // accessLogs.userId est NOT NULL, donc pas de null ici. Cf. Task 6 brief.
  await recordAccess({
    userId: opts.valideParUserId ?? 0,
    action: "insurer_send",
    studyId: null,
    detail: `demande assureur #${requestId} (${studyIds.length} étude(s), ${tailleOctets} octets)`,
    ipAddress: null,
  });

  return { success: true };
}
