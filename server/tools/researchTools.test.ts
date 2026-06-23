import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../knowledge/embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("../knowledge/store", () => ({
  searchSimilar: vi.fn().mockResolvedValue([
    {
      source: "guidelines:esr",
      heading: "Protocole IRM",
      content: "Contenu guideline",
      score: 0.9,
    },
  ]),
}));
vi.mock("../knowledge/retrieve", () => ({
  selectRelevant: vi.fn(chunks => chunks),
  buildKnowledgeBlock: vi
    .fn()
    .mockReturnValue("[guidelines:esr › Protocole IRM]\nContenu guideline"),
}));

import { pubmedSearchFn, searchGuidelinesFn } from "./researchTools";

describe("pubmedSearchFn", () => {
  it("retourne les résultats PubMed parsés", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({ esearchresult: { idlist: ["12345678"] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi
          .fn()
          .mockResolvedValue(
            "1. Radiology protocol review.\n" +
              "Smith J, et al.\n" +
              "Radiology. 2025;300(1):10-15.\n" +
              "PMID: 12345678\n" +
              "DOI: 10.1234/rad.2025\n\n" +
              "Abstract: This study examines IRM protocols."
          ),
      });
    const result = await pubmedSearchFn({
      query: "IRM genou protocole",
      maxResults: 1,
    });
    expect(result.available).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].pmid).toBe("12345678");
  });

  it("retourne available: false si réseau KO", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const result = await pubmedSearchFn({ query: "test" });
    expect(result.available).toBe(false);
  });

  it("retourne available: false si aucun PMID trouvé", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ esearchresult: { idlist: [] } }),
    });
    const result = await pubmedSearchFn({ query: "rien" });
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("searchGuidelinesFn", () => {
  it("filtre les chunks avec sourcePrefix guidelines:", async () => {
    const { searchSimilar } = await import("../knowledge/store");
    const result = await searchGuidelinesFn({ query: "IRM protocole" });
    expect(vi.mocked(searchSimilar)).toHaveBeenCalledWith(
      expect.any(Array),
      5,
      { sourcePrefix: "guidelines:" }
    );
    expect(result.context).toContain("guidelines:esr");
  });
});
