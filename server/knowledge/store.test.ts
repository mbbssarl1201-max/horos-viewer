import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));
vi.mock("../../drizzle/schema", () => ({
  knowledgeChunks: {
    source: "source",
    heading: "heading",
    content: "content",
    embedding: "embedding",
  },
}));

import { searchSimilar } from "./store";
import { getDb } from "../db";

const mockChunks = [
  {
    source: "vault:notes.md",
    heading: "H1",
    content: "vault content",
    embedding: JSON.stringify([1, 0]),
  },
  {
    source: "guidelines:esr",
    heading: "G1",
    content: "guidelines content",
    embedding: JSON.stringify([0, 1]),
  },
];

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([mockChunks[0]]),
      }),
    }),
  } as any);
});

describe("searchSimilar avec sourcePrefix", () => {
  it("sans sourcePrefix appelle la query sans WHERE", async () => {
    const db = (await getDb()) as any;
    db.select.mockReturnValue({
      from: vi.fn().mockResolvedValue(mockChunks),
    });
    const results = await searchSimilar([1, 0], 5);
    expect(results.length).toBe(2);
  });

  it("avec sourcePrefix filtre par source LIKE 'vault:%'", async () => {
    const db = (await getDb()) as any;
    const whereMock = vi.fn().mockResolvedValue([mockChunks[0]]);
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: whereMock }),
    });
    const results = await searchSimilar([1, 0], 5, { sourcePrefix: "vault:" });
    expect(whereMock).toHaveBeenCalled();
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("vault:notes.md");
  });
});
