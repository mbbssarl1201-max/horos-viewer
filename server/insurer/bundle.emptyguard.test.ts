import { describe, it, expect, vi, beforeEach } from "vitest";

// Garde anti-colis-vide de `construireColis` : on mocke les dépendances DB /
// stockage / PDF pour piloter la présence (ou l'absence) de coupes DICOM.
const mocks = {
  getStudyById: vi.fn(),
  listSeriesByStudy: vi.fn(),
  listInstancesBySeries: vi.fn(),
  storageGetBuffer: vi.fn(),
  storagePut: vi.fn(),
  buildStudyExportPdf: vi.fn(),
};

vi.mock("../db", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    getDb: () => Promise.resolve({}),
    getStudyById: (...a: any[]) => mocks.getStudyById(...a),
    listSeriesByStudy: (...a: any[]) => mocks.listSeriesByStudy(...a),
    listInstancesBySeries: (...a: any[]) => mocks.listInstancesBySeries(...a),
  };
});

vi.mock("../storage", () => ({
  storageGetBuffer: (...a: any[]) => mocks.storageGetBuffer(...a),
  storagePut: (...a: any[]) => mocks.storagePut(...a),
}));

vi.mock("../report/reportPdf", () => ({
  buildStudyExportPdf: (...a: any[]) => mocks.buildStudyExportPdf(...a),
}));

import { construireColis } from "./bundle";

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getStudyById.mockResolvedValue({ id: 1, studyInstanceUid: "1.2.3" });
  mocks.storagePut.mockResolvedValue({
    key: "insurer/1/bundle.zip",
    url: "https://minio/x",
  });
});

describe("construireColis — garde anti-colis-vide", () => {
  it("lève si aucune coupe DICOM (étude méta-seule), sans écrire de ZIP", async () => {
    mocks.listSeriesByStudy.mockResolvedValue([]); // aucune série ⇒ aucune image
    // Même si un CR PDF est disponible, un colis sans DICOM doit être refusé.
    mocks.buildStudyExportPdf.mockReturnValue(Buffer.from("%PDF-CR"));

    await expect(construireColis(1, [1])).rejects.toThrow(/[Cc]olis vide/);
    expect(mocks.storagePut).not.toHaveBeenCalled();
  });

  it("produit le colis quand au moins une coupe DICOM est présente", async () => {
    mocks.listSeriesByStudy.mockResolvedValue([{ id: 11 }]);
    mocks.listInstancesBySeries.mockResolvedValue([
      { id: 100, storageKey: "dicom/k", sopInstanceUid: "9.9" },
    ]);
    mocks.storageGetBuffer.mockResolvedValue(Buffer.from("DICM-bytes"));
    mocks.buildStudyExportPdf.mockReturnValue(Buffer.from("%PDF-CR"));

    const r = await construireColis(1, [1]);
    expect(r.bundleKey).toBe("insurer/1/bundle.zip");
    expect(mocks.storagePut).toHaveBeenCalledTimes(1);
  });
});
