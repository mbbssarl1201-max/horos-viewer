import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("./embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("./store", () => ({
  insertChunks: vi.fn().mockResolvedValue(1),
  clearKnowledge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./chunk", () => ({
  chunkMarkdown: vi
    .fn()
    .mockReturnValue([{ heading: "ESR Guideline", content: "Content here" }]),
}));

import { parseRssItems, buildGuidelinesSource } from "./guidelinesSync";

describe("guidelinesSync — fonctions pures", () => {
  it("parseRssItems extrait titre et description du RSS", () => {
    const xml = `<rss><channel>
      <item><title>ESR Guideline 2025</title><description>New protocol</description><link>https://example.com/1</link></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("ESR Guideline 2025");
    expect(items[0].content).toContain("New protocol");
  });

  it("buildGuidelinesSource normalise le slug source", () => {
    expect(buildGuidelinesSource("ESR")).toBe("guidelines:esr");
    expect(buildGuidelinesSource("ACR Guidelines")).toBe(
      "guidelines:acr-guidelines"
    );
  });
});
