import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("generatePreanalysis", () => {
  beforeEach(() => {
    process.env.OLLAMA_URL = "http://ollama-test:11434";
    process.env.OLLAMA_VISION_MODEL = "qwen2.5-vl:3b";
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parse Résultats/Conclusion depuis la réponse Ollama", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content:
              "Résultats:\nPas de fracture visible.\n\nConclusion:\nExamen normal.",
          },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.resultats).toMatch(/Pas de fracture/);
    expect(out.conclusion).toMatch(/Examen normal/);
    expect(out.model).toBe("qwen2.5-vl:3b");
  });

  it("repli : réponse hors-format -> tout dans resultats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: { content: "Texte libre sans sections." },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.resultats).toBe("Texte libre sans sections.");
    expect(out.conclusion).toBe("");
  });

  it("Ollama en erreur -> throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await expect(
      generatePreanalysis([{ pngBase64: "AAAA", sliceIndex: 0 }], {})
    ).rejects.toThrow();
  });

  it("envoie les images en base64 dans le message user", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await generatePreanalysis([{ pngBase64: "IMG1", sliceIndex: 3 }], {
      indication: "douleur",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toContain("IMG1");
    expect(body.model).toBe("qwen2.5-vl:3b");
    expect(body.stream).toBe(false);
  });
});
