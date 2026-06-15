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
      antecedents: "Fracture du tibia en 2024",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userContent = body.messages.find(
      (m: any) => m.role === "user"
    ).content;
    expect(userContent).toMatch(/CT/);
    expect(userContent).toMatch(/Scanner cheville/);
    expect(userContent).toMatch(/Cheville droite/);
    expect(userContent).toMatch(/coupe/i);
    expect(userContent).toMatch(/Fracture du tibia en 2024/);
    expect(userContent).toMatch(/Antécédents/i);
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

  it("plafonne à 6 images envoyées au VLM (Ollama)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const many = Array.from({ length: 8 }, (_, i) => ({
      pngBase64: `IMG${i}`,
      sliceIndex: i,
    }));
    await generatePreanalysis(many, {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toHaveLength(6);
    expect(userMsg.images).toEqual([
      "IMG0",
      "IMG1",
      "IMG2",
      "IMG3",
      "IMG4",
      "IMG5",
    ]);
  });

  it("parse l'anomalie et le numéro de coupe-clé, sans fuite dans la conclusion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content:
              "Technique:\nCT.\n\nRésultats:\nFracture du radius.\n\nConclusion:\nFracture distale.\n\nAnomalie:\noui\n\nCoupe-clé:\n123",
          },
        }),
      }))
    );
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      {}
    );
    expect(out.abnormal).toBe(true);
    expect(out.keySliceNumber).toBe(123);
    // les lignes méta ne doivent PAS contaminer la conclusion
    expect(out.conclusion).toBe("Fracture distale.");
    expect(out.conclusion).not.toMatch(/Anomalie|Coupe/i);
  });

  it("parseKeySlice : « aucune » → pas de coupe-clé, anomalie non", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    const out = parseKeySlice(
      "Conclusion:\nExamen normal.\n\nAnomalie:\nnon\n\nCoupe-clé:\naucune"
    );
    expect(out.abnormal).toBe(false);
    expect(out.keySliceNumber).toBeNull();
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

  it("parseEvolution : extrait le verdict et nettoie la ligne", async () => {
    const { parseEvolution } = await import("./aiPreanalysis");
    const out = parseEvolution(
      "Conclusion:\nLésion stable.\n\nÉvolution:\nstable"
    );
    expect(out.evolution).toBe("stable");
    expect(out.cleaned).not.toMatch(/Évolution/i);
  });

  it("parseEvolution : tolère casse/accents et les 3 verdicts", async () => {
    const { parseEvolution } = await import("./aiPreanalysis");
    expect(parseEvolution("evolution: PROGRESSION").evolution).toBe(
      "progression"
    );
    expect(parseEvolution("Évolution : régression").evolution).toBe(
      "regression"
    );
    expect(parseEvolution("Evolution: Regression").evolution).toBe(
      "regression"
    );
  });

  it("parseEvolution : ligne absente -> null, texte inchangé", async () => {
    const { parseEvolution } = await import("./aiPreanalysis");
    const out = parseEvolution("Conclusion:\nExamen normal.");
    expect(out.evolution).toBeNull();
    expect(out.cleaned).toBe("Conclusion:\nExamen normal.");
  });

  it("mode comparatif : envoie les 2 jeux d'images + blocs étiquetés + parse Évolution", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content:
            "Technique:\nCT.\n\nRésultats:\nComparaison à l'examen du 20240101 : lésion inchangée.\n\nConclusion:\nStabilité.\n\nAnomalie:\noui\n\nCoupe-clé:\n5\n\nÉvolution:\nstable",
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "CUR0", sliceIndex: 1 }],
      {
        modality: "CT",
        prior: {
          images: [{ pngBase64: "OLD0", sliceIndex: 2 }],
          date: "20240101",
        },
      }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toContain("CUR0");
    expect(userMsg.images).toContain("OLD0");
    expect(userMsg.content).toMatch(/EXAMEN ACTUEL/);
    expect(userMsg.content).toMatch(/EXAMEN ANTÉRIEUR du 20240101/);
    expect(body.messages[0].content).toMatch(/Évolution/);
    expect(out.evolution).toBe("stable");
    expect(out.conclusion).toBe("Stabilité.");
  });

  it("parseSections : la ligne Évolution ne pollue pas la Conclusion (sans Anomalie/Coupe-clé)", async () => {
    const { parseSections } = await import("./aiPreanalysis");
    const out = parseSections(
      "Technique:\nCT.\n\nRésultats:\nStable.\n\nConclusion:\nPas de changement.\n\nÉvolution:\nstable"
    );
    expect(out.conclusion).toBe("Pas de changement.");
    expect(out.conclusion).not.toMatch(/Évolution/i);
  });

  it("assertSamePatientStudies : rejette des patients différents", async () => {
    const { assertSamePatientStudies } = await import("./aiPreanalysis");
    expect(() =>
      assertSamePatientStudies({ patientId: "A" }, { patientId: "B" })
    ).toThrow();
    expect(() =>
      assertSamePatientStudies({ patientId: "A" }, { patientId: "" })
    ).toThrow();
    expect(() =>
      assertSamePatientStudies({ patientId: "A" }, { patientId: " A " })
    ).not.toThrow();
  });

  it("pickPriorSeriesId : même modalité prioritaire, repli 1re, vide -> null", async () => {
    const { pickPriorSeriesId } = await import("./aiPreanalysis");
    expect(
      pickPriorSeriesId(
        [
          { id: 1, modality: "MR" },
          { id: 2, modality: "CT" },
        ],
        "ct"
      )
    ).toBe(2);
    expect(pickPriorSeriesId([{ id: 9, modality: "MR" }], "CT")).toBe(9);
    expect(pickPriorSeriesId([], "CT")).toBeNull();
  });
});
