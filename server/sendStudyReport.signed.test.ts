import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getStudyById: vi.fn(),
  listSeriesByStudy: vi.fn(),
  listInstancesBySeries: vi.fn(),
  countRecentAccess: vi.fn(),
  recordAccess: vi.fn(),
  getReportByStudy: vi.fn(),
  getUserById: vi.fn(),
  buildReportPdf: vi.fn(),
  sendEmail: vi.fn(),
  ffmpegAvailable: vi.fn(),
  buildCineMp4: vi.fn(),
};

vi.mock("./db", () => ({
  getStudyById: (...a: any) => mocks.getStudyById(...a),
  listSeriesByStudy: (...a: any) => mocks.listSeriesByStudy(...a),
  listInstancesBySeries: (...a: any) => mocks.listInstancesBySeries(...a),
  countRecentAccess: (...a: any) => mocks.countRecentAccess(...a),
  recordAccess: (...a: any) => mocks.recordAccess(...a),
  getReportByStudy: (...a: any) => mocks.getReportByStudy(...a),
  getUserById: (...a: any) => mocks.getUserById(...a),
}));
vi.mock("./report/reportPdf", () => ({
  buildReportPdf: (...a: any) => mocks.buildReportPdf(...a),
}));
vi.mock("./report/cineVideo", () => ({
  ffmpegAvailable: (...a: any) => mocks.ffmpegAvailable(...a),
  buildCineMp4: (...a: any) => mocks.buildCineMp4(...a),
}));
vi.mock("./report/dicomRaster", () => ({
  renderDicomFrame: () => ({ png: Buffer.from("png") }),
}));
vi.mock("./storage", () => ({
  storageGetBuffer: () => Buffer.from("dcm"),
}));
vi.mock("./email", () => ({
  sendEmail: (...a: any) => mocks.sendEmail(...a),
}));

import { sendStudyReportImpl } from "./report/sendStudyReport";

const onePxPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const baseInput = {
  to: "dr@example.com",
  studyId: 1,
  seriesId: 10,
  report: {
    indication: "I-CLIENT",
    technique: "T-CLIENT",
    resultats: "R-CLIENT",
    conclusion: "C-CLIENT",
  },
  signature: "Signature-CLIENT",
  windowCenter: 40,
  windowWidth: 400,
  keyImages: [{ pngBase64: onePxPng, sliceIndex: 0 }],
  includeVideo: false,
  aiAssisted: true,
} as any;

const ctx = { user: { id: 7 }, req: { ip: "1.2.3.4" } } as any;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.countRecentAccess.mockResolvedValue(0);
  mocks.getStudyById.mockResolvedValue({ id: 1, patientName: "P" });
  mocks.listSeriesByStudy.mockResolvedValue([{ id: 10 }, { id: 11 }]);
  mocks.buildReportPdf.mockReturnValue(Buffer.from("pdf"));
  mocks.sendEmail.mockResolvedValue({ success: true });
  mocks.ffmpegAvailable.mockReturnValue(false);
  mocks.getUserById.mockResolvedValue({
    id: 3,
    name: "Dr House",
    email: "house@example.com",
  });
});

describe("sendStudyReportImpl — verrou CR signé (audit I1)", () => {
  it("FORBIDDEN si aucun compte-rendu n'existe", async () => {
    mocks.getReportByStudy.mockResolvedValue(undefined);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /signé|forbidden/i
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("FORBIDDEN si le compte-rendu est en brouillon", async () => {
    mocks.getReportByStudy.mockResolvedValue({
      status: "draft",
      indication: "I-DB",
      technique: "T-DB",
      resultats: "R-DB",
      conclusion: "C-DB",
      aiGenerated: false,
      signedBy: null,
      signedAt: null,
    });
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /signé|forbidden/i
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("CR signé : envoie l'email avec un contenu issu de la DB (pas du client)", async () => {
    mocks.getReportByStudy.mockResolvedValue({
      status: "signed",
      indication: "I-DB",
      technique: "T-DB",
      resultats: "R-DB",
      conclusion: "C-DB",
      aiGenerated: true,
      signedBy: 3,
      signedAt: new Date("2026-06-15T10:00:00Z"),
    });

    const out = await sendStudyReportImpl(baseInput, ctx);
    expect(out).toEqual({ success: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);

    const pdfArg = mocks.buildReportPdf.mock.calls[0][0];
    // contenu serveur-autoritatif : provient de la DB, jamais de l'input client
    expect(pdfArg.report).toEqual({
      indication: "I-DB",
      technique: "T-DB",
      resultats: "R-DB",
      conclusion: "C-DB",
    });
    expect(pdfArg.report.resultats).toBe("R-DB");
    expect(pdfArg.report.resultats).not.toBe("R-CLIENT");
    // aiAssisted lu depuis report.aiGenerated, pas l'input
    expect(pdfArg.aiAssisted).toBe(true);
    // signature dérivée serveur (signataire), pas l'input "Signature-CLIENT"
    expect(pdfArg.signature).toContain("Dr House");
    expect(pdfArg.signature).not.toContain("Signature-CLIENT");
  });
});
