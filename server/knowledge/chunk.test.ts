import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunk";

describe("chunkMarkdown", () => {
  it("découpe par titres et conserve source + heading", () => {
    const md = "# Poumon\nNodule pulmonaire.\n\n# Os\nFracture du radius.";
    const chunks = chunkMarkdown("radio.md", md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].source).toBe("radio.md");
    expect(chunks[0].heading).toBe("Poumon");
    expect(chunks[0].content).toMatch(/Nodule/);
    const os = chunks.find(c => c.heading === "Os");
    expect(os?.content).toMatch(/Fracture/);
  });
  it("respecte une borne de taille (maxChars)", () => {
    const md = "# T\n" + "a".repeat(2500);
    const chunks = chunkMarkdown("x.md", md, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1000);
  });
  it("markdown vide → []", () => {
    expect(chunkMarkdown("x.md", "   \n\n")).toEqual([]);
  });
});
