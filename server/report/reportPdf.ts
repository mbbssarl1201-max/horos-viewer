import { jsPDF } from "jspdf";
import { CHAMPEL_HEADER, getChampelBlasonDataUrl } from "./champelHeader";

export interface ReportSections {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
}

export interface KeyImage {
  pngBase64: string;
  sliceIndex: number;
  measurements?: string;
}

export interface ReportPdfInput {
  study: {
    id: number;
    patientName?: string | null;
    birthDate?: string | null;
    patientId?: string | null;
    studyDate?: string | null;
    modality?: string | null;
    studyDescription?: string | null;
  };
  report: ReportSections;
  signature: string;
  keyImages: KeyImage[];
  aiAssisted?: boolean;
  antecedents?: string;
  /** Addenda datés à rendre après la signature (corrections post-signature). */
  addenda?: { text: string; date: string; author: string }[];
}

const MARGIN = 14;

// jsPDF Helvetica ne couvre que ISO-8859-1 (0x00–0xFF). Les caractères Unicode
// produits par l'IA (guillemets typographiques, tirets longs, ellipses…) déclenchent
// un fallback vers Courier (rendu monospace) et un calcul de largeur incorrect
// (overflow du texte). On les remplace par leurs équivalents ASCII avant rendu.
function sanitizePdfText(text: string): string {
  return text
    .replace(/[“”„‟«»]/g, '"') // guillemets doubles
    .replace(/[‘’‚‛‹›]/g, "'") // guillemets simples
    .replace(/[–—―]/g, "-") // tirets longs
    .replace(/…/g, "...") // ellipse
    .replace(/•/g, "-") // puce
    .replace(/ /g, " ") // espace insécable
    .replace(/[^\x00-\xFF]/g, "?"); // tout autre Unicode > 0xFF
}

export function buildReportPdf(input: ReportPdfInput): Buffer {
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();
  let y = 14;

  // Header: blason + Institut de Champel
  const blason = getChampelBlasonDataUrl();
  if (blason) {
    try {
      doc.addImage(blason, "PNG", MARGIN, 10, 18, 18);
    } catch {
      /* ignore */
    }
  }
  doc.setFontSize(15);
  doc.text(CHAMPEL_HEADER.name, blason ? MARGIN + 22 : MARGIN, y + 2);
  doc.setFontSize(9);
  doc.text(
    `${CHAMPEL_HEADER.address} • ${CHAMPEL_HEADER.city}  —  ${CHAMPEL_HEADER.phone}  —  ${CHAMPEL_HEADER.email}`,
    blason ? MARGIN + 22 : MARGIN,
    y + 8
  );
  y = 34;
  doc.setDrawColor(180);
  doc.line(MARGIN, y, W - MARGIN, y);
  y += 8;

  // Title + patient identity block
  doc.setFontSize(13);
  doc.text("Compte rendu d'imagerie", MARGIN, y);
  y += 8;
  doc.setFontSize(10);
  [
    `Patient : ${input.study.patientName || "—"}`,
    `Né(e) le : ${input.study.birthDate || "—"}    ID : ${input.study.patientId || "—"}`,
    `Date d'étude : ${input.study.studyDate || "—"}    Modalité : ${input.study.modality || "—"}`,
    `Examen : ${input.study.studyDescription || "—"}`,
  ].forEach(line => {
    doc.text(line, MARGIN, y);
    y += 6;
  });
  y += 4;

  // Helper to render a titled section with page-break guard
  const section = (title: string, body: string) => {
    if (y > 270) {
      doc.addPage();
      y = 16;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(title, MARGIN, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(
      sanitizePdfText(body || "—"),
      W - 2 * MARGIN
    );
    for (const l of lines) {
      if (y > 285) {
        doc.addPage();
        y = 16;
      }
      doc.text(l, MARGIN, y);
      y += 5;
    }
    y += 4;
  };

  if (input.antecedents) section("Antécédents", input.antecedents);
  section("Indication", input.report.indication);
  section("Technique", input.report.technique);
  section("Résultats", input.report.resultats);
  section("Conclusion", input.report.conclusion);

  // Key images: one per page
  for (const img of input.keyImages) {
    doc.addPage();
    let iy = 16;
    doc.setFontSize(10);
    doc.text(`Image clé — coupe ${img.sliceIndex + 1}`, MARGIN, iy);
    iy += 6;
    try {
      doc.addImage(
        `data:image/png;base64,${img.pngBase64}`,
        "PNG",
        MARGIN,
        iy,
        W - 2 * MARGIN,
        160
      );
      iy += 166;
    } catch {
      /* image illisible : on saute */
    }
    if (img.measurements) {
      doc.text(
        doc.splitTextToSize(`Mesures : ${img.measurements}`, W - 2 * MARGIN),
        MARGIN,
        iy
      );
    }
  }

  // Signature line + motto
  if (y > 265) {
    doc.addPage();
    y = 16;
  }
  y += 8;
  doc.setDrawColor(180);
  doc.line(MARGIN, y, MARGIN + 70, y);
  y += 5;
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text(`Dr ${input.signature}`, MARGIN, y);
  if (input.aiAssisted) {
    y += 6;
    doc.setFontSize(7);
    doc.setTextColor(150);
    doc.text(
      "Pré-analyse assistée par IA, validée par le médecin signataire.",
      MARGIN,
      y
    );
  }
  doc.setFontSize(8);
  doc.setTextColor(130);
  doc.text(CHAMPEL_HEADER.motto, W - MARGIN, y, { align: "right" });

  if (input.addenda && input.addenda.length) {
    for (const ad of input.addenda) {
      y += 8;
      if (y > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage();
        y = 14;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(`Addendum — ${ad.author}, ${ad.date}`, MARGIN, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      const lines = doc.splitTextToSize(
        sanitizePdfText(ad.text),
        W - 2 * MARGIN
      );
      doc.text(lines, MARGIN, y);
      y += lines.length * 5;
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}

/** Étude minimale requise pour la fiche d'export (métadonnées, pas de contenu clinique). */
export interface StudyExportInput {
  patientName?: string | null;
  patientId?: string | null;
  birthDate?: string | null;
  studyDate?: string | null;
  modality?: string | null;
  studyDescription?: string | null;
  institution?: string | null;
  referringPhysician?: string | null;
  numberOfSeries?: number | null;
  numberOfInstances?: number | null;
}

/**
 * PDF d'export minimal (métadonnées étude/patient, pas de contenu clinique
 * signé) — utilisé par `GET /api/export/pdf-report/:studyId` et par le colis
 * assureur (`construireColis`). Extrait de l'ancienne route inline pour être
 * réutilisable sans dupliquer la mise en page (aucun changement de rendu).
 */
export function buildStudyExportPdf(study: StudyExportInput): Buffer {
  const doc = new jsPDF();

  // Header
  doc.setFontSize(18);
  doc.setTextColor(0, 102, 204);
  doc.text("Radiology Report", 20, 20);
  doc.setDrawColor(0, 102, 204);
  doc.line(20, 24, 190, 24);

  // Patient info
  doc.setFontSize(12);
  doc.setTextColor(0, 0, 0);
  doc.text("Patient Information", 20, 35);
  doc.setFontSize(10);
  doc.text(`Name: ${study.patientName || "N/A"}`, 25, 43);
  doc.text(`Patient ID: ${study.patientId || "N/A"}`, 25, 50);
  doc.text(`Date of Birth: ${study.birthDate || "N/A"}`, 25, 57);

  // Study info
  doc.setFontSize(12);
  doc.text("Study Information", 20, 70);
  doc.setFontSize(10);
  doc.text(`Study Date: ${study.studyDate || "N/A"}`, 25, 78);
  doc.text(`Modality: ${study.modality || "N/A"}`, 25, 85);
  doc.text(`Description: ${study.studyDescription || "N/A"}`, 25, 92);
  doc.text(`Institution: ${study.institution || "N/A"}`, 25, 99);
  doc.text(
    `Referring Physician: ${study.referringPhysician || "N/A"}`,
    25,
    106
  );
  doc.text(`Number of Series: ${study.numberOfSeries || 0}`, 25, 113);
  doc.text(`Number of Images: ${study.numberOfInstances || 0}`, 25, 120);

  // Footer
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(`Generated: ${new Date().toISOString()}`, 20, 280);
  doc.text("MediView - For diagnostic purposes only", 20, 286);

  return Buffer.from(doc.output("arraybuffer"));
}
