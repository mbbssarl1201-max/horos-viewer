import { describe, it, expect, vi, afterEach } from "vitest";
import { cosineSimilarity } from "./embeddings";

describe("cosineSimilarity", () => {
  it("vecteurs identiques → 1, orthogonaux → 0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("dimensions différentes ou vide → 0 (garde-fou)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("embedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("appelle /api/embeddings et renvoie le vecteur", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { embedText } = await import("./embeddings");
    const v = await embedText("nodule");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.prompt).toBe("nodule");
    expect(typeof body.model).toBe("string");
  });
});
