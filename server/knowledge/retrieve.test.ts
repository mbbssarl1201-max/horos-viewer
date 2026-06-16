import { describe, it, expect } from "vitest";
import { selectRelevant, buildKnowledgeBlock } from "./retrieve";
import type { SimilarChunk } from "./store";

const mk = (source: string, score: number, content = "x"): SimilarChunk => ({
  source,
  heading: "H",
  content,
  score,
});

describe("selectRelevant", () => {
  it("liste vide → []", () => {
    expect(selectRelevant([])).toEqual([]);
  });

  it("filtre les scores sous le seuil (défaut 0.55)", () => {
    const out = selectRelevant([mk("a", 0.9), mk("b", 0.4), mk("c", 0.6)]);
    expect(out.map(c => c.source)).toEqual(["a", "c"]);
  });

  it("trie par score décroissant", () => {
    const out = selectRelevant([mk("a", 0.6), mk("b", 0.9)]);
    expect(out.map(c => c.source)).toEqual(["b", "a"]);
  });

  it("respecte maxChunks", () => {
    const out = selectRelevant(
      [mk("a", 0.9), mk("b", 0.8), mk("c", 0.7), mk("d", 0.65), mk("e", 0.6)],
      { maxChunks: 2 }
    );
    expect(out.map(c => c.source)).toEqual(["a", "b"]);
  });

  it("coupe quand maxChars est atteint", () => {
    const big = "y".repeat(2000);
    const out = selectRelevant([mk("a", 0.9, big), mk("b", 0.8, big)], {
      maxChars: 2500,
    });
    expect(out.map(c => c.source)).toEqual(["a"]);
  });
});

describe("buildKnowledgeBlock", () => {
  it("liste vide → chaîne vide", () => {
    expect(buildKnowledgeBlock([])).toBe("");
  });

  it("inclut source, heading, contenu et une garde", () => {
    const out = buildKnowledgeBlock([
      mk("proto.md", 0.9, "texte de référence"),
    ]);
    expect(out).toContain("proto.md");
    expect(out).toContain("texte de référence");
    expect(out.toLowerCase()).toContain("si pertinent");
  });
});
