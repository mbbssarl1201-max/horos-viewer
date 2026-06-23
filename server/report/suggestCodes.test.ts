import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../_core/env", () => ({
  ENV: { ollamaUrl: "http://x", ollamaTextModel: "m" },
}));
import { suggestCodes } from "./suggestCodes";

describe("suggestCodes CIM-10 + TARDOC", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("renvoie codes ET tardoc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              codes: [{ code: "R93.1", label: "anomalie" }],
              tardoc: [{ code: "39.0010", label: "CT abdomen" }],
            }),
          },
        }),
      }))
    );
    const r = await suggestCodes("res", "concl");
    expect(r.codes[0].code).toBe("R93.1");
    expect(r.tardoc[0].code).toBe("39.0010");
  });
  it("tableaux vides si réponse vide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ message: { content: "{}" } }),
      }))
    );
    const r = await suggestCodes("a", "b");
    expect(r.codes).toEqual([]);
    expect(r.tardoc).toEqual([]);
  });
});
