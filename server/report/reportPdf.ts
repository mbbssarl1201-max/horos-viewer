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
}

const MARGIN = 14;

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
    const lines = doc.splitTextToSize(body || "—", W - 2 * MARGIN);
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
  doc.setFontSize(8);
  doc.setTextColor(130);
  doc.text(CHAMPEL_HEADER.motto, W - MARGIN, y, { align: "right" });

  return Buffer.from(doc.output("arraybuffer"));
}
