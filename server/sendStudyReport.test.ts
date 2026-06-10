import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getStudyById: vi.fn(),
  listSeriesByStudy: vi.fn(),
  listInstancesBySeries: vi.fn(),
  countRecentAccess: vi.fn(),
  recordAccess: vi.fn(),
  storageGetBuffer: vi.fn(),
  sendEmail: vi.fn(),
  renderDicomFrame: vi.fn(),
  buildCineMp4: vi.fn(),
  ffmpegAvailable: vi.fn(),
  buildReportPdf: vi.fn(),
};

vi.mock("./db", () => ({
  getStudyById: (...a: any) => mocks.getStudyById(...a),
  listSeriesByStudy: (...a: any) => mocks.listSeriesByStudy(...a),
  listInstancesBySeries: (...a: any) => mocks.listInstancesBySeries(...a),
  countRecentAccess: (...a: any) => mocks.countRecentAccess(...a),
  recordAccess: (...a: any) => mocks.recordAccess(...a),
}));
vi.mock("./storage", () => ({
  storageGetBuffer: (...a: any) => mocks.storageGetBuffer(...a),
}));
vi.mock("./email", () => ({ sendEmail: (...a: any) => mocks.sendEmail(...a) }));
vi.mock("./report/dicomRaster", () => ({
  renderDicomFrame: (...a: any) => mocks.renderDicomFrame(...a),
}));
vi.mock("./report/cineVideo", () => ({
  buildCineMp4: (...a: any) => mocks.buildCineMp4(...a),
  ffmpegAvailable: (...a: any) => mocks.ffmpegAvailable(...a),
}));
vi.mock("./report/reportPdf", () => ({
  buildReportPdf: (...a: any) => mocks.buildReportPdf(...a),
}));

import { sendStudyReportImpl } from "./report/sendStudyReport";

const baseInput = {
  to: "confrere@example.ch",
  studyId: 1,
  seriesId: 1,
  report: { indication: "i", technique: "t", resultats: "r", conclusion: "c" },
  signature: "Test",
  windowCenter: 40,
  windowWidth: 400,
  keyImages: [],
  includeVideo: false,
  message: undefined,
};
const ctx = { user: { id: 7 }, req: { ip: "1.2.3.4" } } as any;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.countRecentAccess.mockResolvedValue(0);
  mocks.getStudyById.mockResolvedValue({ id: 1, patientName: "P" });
  mocks.listSeriesByStudy.mockResolvedValue([
    { id: 1, seriesInstanceUid: "1.2" },
  ]);
  mocks.listInstancesBySeries.mockResolvedValue([
    { storageKey: "a", instanceNumber: 1 },
    { storageKey: "b", instanceNumber: 2 },
  ]);
  mocks.buildReportPdf.mockReturnValue(Buffer.from("%PDF-1"));
  mocks.sendEmail.mockResolvedValue({ success: true });
});

describe("sendStudyReportImpl", () => {
  it("refuse au-delà du rate-limit (20/h)", async () => {
    mocks.countRecentAccess.mockResolvedValue(20);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /limite|too many/i
    );
  });
  it("404 si l'étude n'existe pas", async () => {
    mocks.getStudyById.mockResolvedValue(undefined);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /introuvable|not found/i
    );
  });
  it("400 si la série n'appartient pas à l'étude", async () => {
    mocks.listSeriesByStudy.mockResolvedValue([
      { id: 99, seriesInstanceUid: "x" },
    ]);
    await expect(sendStudyReportImpl(baseInput, ctx)).rejects.toThrow(
      /série|series/i
    );
  });
  it("PDF seul quand includeVideo=false", async () => {
    const res = await sendStudyReportImpl(baseInput, ctx);
    expect(mocks.buildCineMp4).not.toHaveBeenCalled();
    expect(mocks.buildReportPdf).toHaveBeenCalled();
    expect(mocks.recordAccess).toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(res.success).toBe(true);
  });
  it("fail-closed : rendu d'une frame échoue -> pas d'email", async () => {
    mocks.ffmpegAvailable.mockReturnValue(true);
    mocks.renderDicomFrame.mockImplementation(() => {
      throw new Error("decode boom");
    });
    await expect(
      sendStudyReportImpl({ ...baseInput, includeVideo: true }, ctx)
    ).rejects.toThrow();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
