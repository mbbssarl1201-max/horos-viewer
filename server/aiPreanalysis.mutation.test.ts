import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getStudyById: vi.fn(),
  listSeriesByStudy: vi.fn(),
  countRecentAccess: vi.fn(),
  recordAccess: vi.fn(),
  snapshotAiEvaluation: vi.fn(),
};
vi.mock("./db", () => ({
  getStudyById: (...a: any) => mocks.getStudyById(...a),
  listSeriesByStudy: (...a: any) => mocks.listSeriesByStudy(...a),
  countRecentAccess: (...a: any) => mocks.countRecentAccess(...a),
  recordAccess: (...a: any) => mocks.recordAccess(...a),
  snapshotAiEvaluation: (...a: any) => mocks.snapshotAiEvaluation(...a),
}));

import * as ai from "./report/aiPreanalysis";
const { runAiPreanalysis } = ai;

const onePxPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const baseInput = {
  studyId: 1,
  keyImages: [{ pngBase64: onePxPng, sliceIndex: 0 }],
  indication: "douleur",
};
const ctx = { user: { id: 7 }, req: { ip: "1.2.3.4" } } as any;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.countRecentAccess.mockResolvedValue(0);
  mocks.getStudyById.mockResolvedValue({ id: 1, patientName: "P" });
  mocks.listSeriesByStudy.mockResolvedValue([{ id: 10 }, { id: 11 }]);
  vi.spyOn(ai._internal, "generatePreanalysis").mockResolvedValue({
    resultats: "R",
    conclusion: "C",
    model: "qwen2.5-vl:3b",
  });
});

describe("runAiPreanalysis", () => {
  it("refuse au-delà du rate-limit", async () => {
    mocks.countRecentAccess.mockResolvedValue(30);
    await expect(runAiPreanalysis(baseInput, ctx)).rejects.toThrow(
      /limite|too many/i
    );
  });
  it("404 si étude absente", async () => {
    mocks.getStudyById.mockResolvedValue(undefined);
    await expect(runAiPreanalysis(baseInput, ctx)).rejects.toThrow(
      /introuvable|not found/i
    );
  });
  it("rejette un PNG invalide", async () => {
    await expect(
      runAiPreanalysis(
        { ...baseInput, keyImages: [{ pngBase64: "bm90cG5n", sliceIndex: 0 }] },
        ctx
      )
    ).rejects.toThrow(/png/i);
  });
  it("anti-IDOR : refuse une série n'appartenant pas à l'étude", async () => {
    await expect(
      runAiPreanalysis({ ...baseInput, seriesId: 999 }, ctx)
    ).rejects.toThrow(/inconnue|forbidden/i);
  });
  it("succès : renvoie le brouillon + audit", async () => {
    const out = await runAiPreanalysis(baseInput, ctx);
    expect(out).toEqual({
      resultats: "R",
      conclusion: "C",
      model: "qwen2.5-vl:3b",
      // sans seriesId, l'image clé est prise depuis keyImages (coupe du milieu)
      keyImage: { pngBase64: onePxPng, sliceIndex: 0 },
      // pas de priorStudyId → pas de comparaison d'antériorité
      comparedPriorDate: null,
      // pas de doubleRead → pas de 2e avis
      secondOpinion: null,
    });
    expect(mocks.recordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: "study.ai.preanalysis", studyId: 1 })
    );
  });
});
