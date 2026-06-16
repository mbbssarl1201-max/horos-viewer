import { describe, it, expect } from "vitest";
import { buildReportPdf } from "./reportPdf";

const study = {
  id: 1,
  patientName: "TEST^PATIENT",
  birthDate: "19800101",
  patientId: "X1",
  studyDate: "20260324",
  modality: "CT",
  studyDescription: "Cheville",
} as any;

describe("buildReportPdf", () => {
  it("produit un PDF valide commençant par %PDF", () => {
    const pdf = buildReportPdf({
      study,
      report: {
        indication: "Douleur",
        technique: "CT 0.5mm",
        resultats: "RAS",
        conclusion: "Normal",
      },
      signature: "Test",
      keyImages: [],
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(800);
  });
  it("ajoute la mention IA quand aiAssisted=true", () => {
    const base = {
      study: { id: 1 } as any,
      report: { indication: "", technique: "", resultats: "", conclusion: "" },
      signature: "T",
      keyImages: [],
    };
    const withoutAi = buildReportPdf({ ...base, aiAssisted: false });
    const withAi = buildReportPdf({ ...base, aiAssisted: true });
    expect(withAi.length).toBeGreaterThan(withoutAi.length);
    expect(withAi.subarray(0, 4).toString()).toBe("%PDF");
  });
  it("ajoute la section Antécédents quand antecedents est fourni", () => {
    const base = {
      study,
      report: {
        indication: "Douleur",
        technique: "CT 0.5mm",
        resultats: "RAS",
        conclusion: "Normal",
      },
      signature: "Test",
      keyImages: [],
    };
    const without = buildReportPdf(base);
    const withAntecedents = buildReportPdf({
      ...base,
      antecedents: "Fracture 2024",
    });
    expect(withAntecedents.length).toBeGreaterThan(without.length);
    expect(withAntecedents.subarray(0, 4).toString()).toBe("%PDF");
  });
  it("inclut les addenda dans le PDF", () => {
    const buf = buildReportPdf({
      study: { id: 1, patientName: "X", modality: "CT" },
      report: {
        indication: "",
        technique: "",
        resultats: "RAS",
        conclusion: "Normal",
      },
      signature: "Dr Test — 12/06/2026",
      keyImages: [],
      addenda: [
        {
          text: "Précision ajoutée",
          date: "12/06/2026 14:00",
          author: "Dr Test",
        },
      ],
    });
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });
  it("n'échoue pas avec une image clé PNG", () => {
    const onePx =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const pdf = buildReportPdf({
      study,
      report: { indication: "", technique: "", resultats: "", conclusion: "" },
      signature: "Test",
      keyImages: [
        { pngBase64: onePx, sliceIndex: 5, measurements: "Length 12mm" },
      ],
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
