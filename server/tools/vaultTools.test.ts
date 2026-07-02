import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../knowledge/embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("../knowledge/store", () => ({
  searchSimilar: vi.fn().mockResolvedValue([
    {
      source: "vault:notes.md",
      heading: "Protocole IRM",
      content: "Contenu IRM",
      score: 0.8,
    },
  ]),
}));
vi.mock("../knowledge/retrieve", () => ({
  selectRelevant: vi.fn(chunks => chunks),
  buildKnowledgeBlock: vi
    .fn()
    .mockReturnValue("[vault:notes.md › Protocole IRM]\nContenu IRM"),
}));

import { searchVaultFn } from "./vaultTools";

describe("searchVaultFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retourne le contexte vault et les sources", async () => {
    const result = await searchVaultFn({ query: "protocole IRM genou" });
    expect(result.context).toContain("Contenu IRM");
    expect(result.sources).toContain("vault:notes.md");
  });

  it("filtre avec sourcePrefix vault:", async () => {
    await searchVaultFn({ query: "protocole IRM genou" });
    const { searchSimilar } = await import("../knowledge/store");
    expect(vi.mocked(searchSimilar)).toHaveBeenCalledWith(
      expect.any(Array),
      5,
      { sourcePrefix: "vault:" }
    );
  });

  it("retourne contexte vide si Ollama indisponible", async () => {
    const { embedText } = await import("../knowledge/embeddings");
    vi.mocked(embedText).mockRejectedValueOnce(new Error("timeout"));
    const result = await searchVaultFn({ query: "test" });
    expect(result.context).toBe("");
    expect(result.sources).toEqual([]);
  });
});
