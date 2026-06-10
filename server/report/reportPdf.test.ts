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
