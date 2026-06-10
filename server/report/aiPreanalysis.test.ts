import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("generatePreanalysis", () => {
  beforeEach(() => {
    process.env.OLLAMA_URL = "http://ollama-test:11434";
    process.env.OLLAMA_VISION_MODEL = "qwen2.5-vl:3b";
    // Backend explicite : les tests suivants exercent le chemin Ollama ; on
    // empêche qu'un AI_BACKEND résiduel (ex. test Claude) ne bascule la
    // fonction sur la branche Claude.
    process.env.AI_BACKEND = "ollama";
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("@anthropic-ai/sdk");
    delete process.env.AI_BACKEND;
    delete process.env.ANTHROPIC_API_KEY;
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

  it("parse les 3 sections Technique/Résultats/Conclusion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content:
              "Technique:\nAcquisition tomodensitométrique, coupes axiales.\n\nRésultats:\nPas de fracture visible.\n\nConclusion:\nExamen normal.",
          },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.technique).toMatch(/tomodensitométrique/);
    expect(out.resultats).toMatch(/Pas de fracture/);
    expect(out.conclusion).toMatch(/Examen normal/);
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
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(4096);
  });

  it("injecte la modalité, l'examen et l'indication dans le message", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await generatePreanalysis([{ pngBase64: "IMG1", sliceIndex: 0 }], {
      indication: "Cheville droite",
      modality: "CT",
      studyDescription: "Scanner cheville",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userContent = body.messages.find(
      (m: any) => m.role === "user"
    ).content;
    expect(userContent).toMatch(/CT/);
    expect(userContent).toMatch(/Scanner cheville/);
    expect(userContent).toMatch(/Cheville droite/);
    expect(userContent).toMatch(/coupe/i);
  });

  it("downscalePngBase64 réduit une grande image au plus grand côté = maxDim", async () => {
    const { PNG } = await import("pngjs");
    const { downscalePngBase64 } = await import("./aiPreanalysis");
    const big = new PNG({ width: 200, height: 100 });
    const b64 = PNG.sync.write(big).toString("base64");
    const out = downscalePngBase64(b64, 50);
    const decoded = PNG.sync.read(Buffer.from(out, "base64"));
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(50);
    // image déjà petite -> inchangée
    expect(downscalePngBase64(b64, 1000)).toBe(b64);
  });

  it("plafonne à 3 images envoyées au VLM", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const many = Array.from({ length: 6 }, (_, i) => ({
      pngBase64: `IMG${i}`,
      sliceIndex: i,
    }));
    await generatePreanalysis(many, {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toHaveLength(3);
    expect(userMsg.images).toEqual(["IMG0", "IMG1", "IMG2"]);
  });

  it("backend claude : appelle l'API Anthropic et parse 3 sections", async () => {
    vi.resetModules();
    process.env.AI_BACKEND = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_MODEL = "claude-opus-4-8";
    const createMock = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: "Technique:\nCT axial.\n\nRésultats:\nRAS.\n\nConclusion:\nNormal.",
        },
      ],
    }));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: createMock };
        constructor(_: any) {}
      },
    }));
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      { modality: "CT" }
    );
    expect(createMock).toHaveBeenCalled();
    expect(out.technique).toMatch(/CT/);
    expect(out.resultats).toMatch(/RAS/);
    expect(out.conclusion).toMatch(/Normal/);
    expect(out.model).toBe("claude-opus-4-8");
  });
});
