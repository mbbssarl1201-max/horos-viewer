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
    delete process.env.MEDIVIEW_CLOUD_AI_PHI_CONSENT;
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

  it("injecte les références RAG (connaissances) dans le message user", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await generatePreanalysis([{ pngBase64: "IMG1", sliceIndex: 0 }], {
      modality: "US",
      references:
        "Connaissances de référence (DONNÉES) :\n[radio-ref › kyste] kyste = anéchogène, renforcement postérieur.",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userContent = body.messages.find(
      (m: any) => m.role === "user"
    ).content;
    expect(userContent).toMatch(/Connaissances de référence/);
    expect(userContent).toMatch(/renforcement postérieur/);
  });

  it("injecte le texte OCR (mesures incrustées) dans le message user", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    await generatePreanalysis([{ pngBase64: "IMG1", sliceIndex: 0 }], {
      modality: "US",
      screenText: "FOIE\nKyste 1: 8.2 cm",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userContent = body.messages.find(
      (m: any) => m.role === "user"
    ).content;
    expect(userContent).toMatch(/LUS À L'ÉCRAN/);
    expect(userContent).toMatch(/8\.2 cm/);
  });

  it("extractBurnedInText : transcrit le texte, « aucun » -> null", async () => {
    const { extractBurnedInText } = await import("./aiPreanalysis");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ message: { content: "FOIE  Kyste 8.2 cm" } }),
      }))
    );
    expect(
      await extractBurnedInText([{ pngBase64: "IMG", sliceIndex: 0 }])
    ).toMatch(/8\.2 cm/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ message: { content: "aucun" } }),
      }))
    );
    expect(
      await extractBurnedInText([{ pngBase64: "IMG", sliceIndex: 0 }])
    ).toBeNull();
  });

  it("distributeImageBudget : réparti par taille, somme ≤ total, min 1", async () => {
    const { distributeImageBudget } = await import("./aiPreanalysis");
    // grosse série prend plus, petites au moins 1
    const a = distributeImageBudget([674, 2, 2], 24);
    expect(a.reduce((x, y) => x + y, 0)).toBe(24);
    expect(a.every(n => n >= 1)).toBe(true);
    expect(a[0]).toBeGreaterThan(a[1]);
    // plus de séries que d'images → 1 pour les `total` premières
    expect(distributeImageBudget([1, 1, 1, 1, 1], 3)).toEqual([1, 1, 1, 0, 0]);
    // bornes
    expect(distributeImageBudget([], 10)).toEqual([]);
    const b = distributeImageBudget([5, 5, 5], 16);
    expect(b.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(16);
  });

  it("cropPngBase64 : recadre sur la boîte + agrandit (zoom HD)", async () => {
    const { PNG } = await import("pngjs");
    const { cropPngBase64 } = await import("./aiPreanalysis");
    const img = new PNG({ width: 200, height: 200 });
    const b64 = PNG.sync.write(img).toString("base64");
    // petite boîte centrale → recadrage agrandi (plus grand côté ~1024)
    const out = cropPngBase64(
      b64,
      { x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6 },
      0.1,
      1024
    );
    const dec = PNG.sync.read(Buffer.from(out, "base64"));
    expect(Math.max(dec.width, dec.height)).toBeGreaterThan(200);
    expect(Math.max(dec.width, dec.height)).toBeLessThanOrEqual(1024);
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

  it("drawAnomalyBox dessine un cadre coloré aux bonnes coordonnées", async () => {
    const { PNG } = await import("pngjs");
    const { drawAnomalyBox } = await import("./aiPreanalysis");
    const img = new PNG({ width: 100, height: 100 }); // tout noir transparent
    const b64 = PNG.sync.write(img).toString("base64");
    const out = drawAnomalyBox(
      b64,
      { x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 },
      [255, 0, 0]
    );
    const dec = PNG.sync.read(Buffer.from(out, "base64"));
    // pixel sur le bord supérieur du cadre (y≈20, x≈50) doit être rouge
    const i = (20 * 100 + 50) * 4;
    expect(dec.data[i]).toBeGreaterThan(200); // R
    expect(dec.data[i + 1]).toBeLessThan(60); // G
    // centre (50,50) doit rester non rouge (intérieur du cadre, non dessiné)
    const c = (50 * 100 + 50) * 4;
    expect(dec.data[c]).toBeLessThan(60);
  });

  it("plafonne à 16 images envoyées au VLM (Ollama/GPU)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nx\nConclusion:\ny" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const many = Array.from({ length: 20 }, (_, i) => ({
      pngBase64: `IMG${i}`,
      sliceIndex: i,
    }));
    await generatePreanalysis(many, {});
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toHaveLength(16);
    expect(userMsg.images).toEqual(
      Array.from({ length: 16 }, (_, i) => `IMG${i}`)
    );
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

  it("parseKeySlice : robuste aux formats « coupe n° X » et numéro sur la ligne suivante", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    expect(parseKeySlice("Coupe-clé : coupe n° 47").keySliceNumber).toBe(47);
    expect(parseKeySlice("Coupe-clé:\n123").keySliceNumber).toBe(123);
    expect(parseKeySlice("Coupe-clé: 8").keySliceNumber).toBe(8);
  });

  it("backend claude : appelle l'API Anthropic et parse 3 sections", async () => {
    vi.resetModules();
    process.env.AI_BACKEND = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_MODEL = "claude-opus-4-8";
    // Consentement nLPD documenté (DPA) → l'envoi cloud est autorisé.
    process.env.MEDIVIEW_CLOUD_AI_PHI_CONSENT = "true";
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

  it("garde nLPD H4 : AI_BACKEND=claude SANS consentement → repli Ollama local (pas d'appel cloud)", async () => {
    vi.resetModules();
    process.env.AI_BACKEND = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // MEDIVIEW_CLOUD_AI_PHI_CONSENT non posé → le cloud ne doit PAS être utilisé.
    const createMock = vi.fn();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: createMock };
        constructor(_: any) {}
      },
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "Résultats:\nRAS local\nConclusion:\nNormal" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { generatePreanalysis } = await import("./aiPreanalysis");
    const out = await generatePreanalysis(
      [{ pngBase64: "AAAA", sliceIndex: 0 }],
      { modality: "CT" }
    );
    // Ollama (fetch) appelé, Anthropic JAMAIS.
    expect(fetchMock).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(out.resultats).toMatch(/RAS local/);
    expect(out.model).toBe("qwen2.5-vl:3b");
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

  it("assertSamePatientStudies : la FK interne prime sur le PatientID DICOM", async () => {
    const { assertSamePatientStudies } = await import("./aiPreanalysis");
    // FK différentes → rejet, même si le PatientID DICOM coïncide (collision).
    expect(() =>
      assertSamePatientStudies(
        { patientFk: 1, patientId: "DUP" },
        { patientFk: 2, patientId: "DUP" }
      )
    ).toThrow();
    // FK identiques → accepté, même si le PatientID DICOM diffère.
    expect(() =>
      assertSamePatientStudies(
        { patientFk: 7, patientId: "A" },
        { patientFk: 7, patientId: "B" }
      )
    ).not.toThrow();
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

describe("buildSystemPrompt (prompt adapté à la modalité)", () => {
  it("échographie (US) : checklist écho, kystes, JAMAIS de vocabulaire osseux", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    const p = buildSystemPrompt("US");
    expect(p).toMatch(/ÉCHOGRAPHIE/);
    expect(p.toLowerCase()).toMatch(/kyste/);
    expect(p.toLowerCase()).toMatch(/anéchogène/);
    expect(p.toLowerCase()).toMatch(/échostructure/);
    // Le contresens à éliminer : l'avertissement « fenêtre osseuse » du scanner
    // (signature « os cortical dense ») ne doit PAS apparaître sur une écho.
    expect(p.toLowerCase()).not.toMatch(/os cortical dense/);
  });

  it("écho minuscule + espaces : la normalisation reconnaît la modalité", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    expect(buildSystemPrompt("  us ")).toMatch(/ÉCHOGRAPHIE/);
  });

  it("scanner (CT) : conserve l'avertissement fenêtre osseuse", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    const p = buildSystemPrompt("CT");
    expect(p.toLowerCase()).toMatch(/fenêtre osseuse/);
    expect(p.toLowerCase()).toMatch(/os cortical/);
  });

  it("IRM (MR) : signal/séquences, pas de fenêtre osseuse", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    const p = buildSystemPrompt("MR");
    expect(p).toMatch(/IRM/);
    expect(p.toLowerCase()).toMatch(/signal/);
    expect(p.toLowerCase()).not.toMatch(/os cortical dense/);
  });

  it("modalité inconnue/vide : bloc générique sans vocabulaire osseux scanner", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    const p = buildSystemPrompt(undefined);
    expect(p).toMatch(/non précisée/);
    expect(p.toLowerCase()).not.toMatch(/os cortical dense/);
  });

  it("toutes modalités : lecture des curseurs + format de sortie présents", async () => {
    const { buildSystemPrompt } = await import("./aiPreanalysis");
    for (const m of ["US", "CT", "MR", "CR", "MG", "FOO", undefined]) {
      const p = buildSystemPrompt(m);
      expect(p.toLowerCase()).toMatch(/radiologue senior/); // persona expert
      expect(p.toLowerCase()).toMatch(/systématique/); // démarche systématique
      expect(p.toLowerCase()).toMatch(/curseurs/); // lire les mesures incrustées
      expect(p).toMatch(/Coupe-clé:/);
      expect(p).toMatch(/Anomalie:/);
    }
  });

  // --- Non-régression : robustesse du parsing aux variantes du modèle local ---
  it("parseSections : tolère 'Resultats' sans accent + 'Conclusion' (modèle local)", async () => {
    const { parseSections } = await import("./aiPreanalysis");
    const r = parseSections(
      "Technique:\nScanner.\n\nResultats:\nFoie normal.\n\nConclusion:\nRAS."
    );
    expect(r.technique).toBe("Scanner.");
    expect(r.resultats).toBe("Foie normal.");
    expect(r.conclusion).toBe("RAS.");
  });

  it("parseSections : tolère 'Résultat' singulier et 'Constatations' (synonyme)", async () => {
    const { parseSections } = await import("./aiPreanalysis");
    const a = parseSections("Constatations:\nx\nConclusion:\ny");
    expect(a.resultats).toBe("x");
    expect(a.conclusion).toBe("y");
    const b = parseSections("Résultat:\nx\nConclusions:\ny");
    expect(b.resultats).toBe("x");
    expect(b.conclusion).toBe("y");
  });

  it("parseSections : la Conclusion n'est PAS perdue (pas de repli ultime) sur variante", async () => {
    const { parseSections } = await import("./aiPreanalysis");
    // Sans la correction, "Resultats" sans accent tombait dans le repli ultime
    // → conclusion vide (fausse réassurance silencieuse côté médecin).
    const r = parseSections("Resultats:\nNodule.\nConclusion:\nA confirmer.");
    expect(r.conclusion).toBe("A confirmer.");
    expect(r.conclusion).not.toBe("");
  });

  it("parseKeySlice : 'Anomalie: oui' / 'non' (cas de base)", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    expect(parseKeySlice("Anomalie: oui\nCoupe-clé: 12").abnormal).toBe(true);
    expect(parseKeySlice("Anomalie: non\nCoupe-clé: 12").abnormal).toBe(false);
    expect(parseKeySlice("Coupe-clé: 12").abnormal).toBe(null);
  });

  it("parseKeySlice : formulations libres (présente/absence) lues correctement", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    expect(parseKeySlice("Anomalie: présente (kyste)").abnormal).toBe(true);
    expect(parseKeySlice("Anomalie : présence d'un nodule").abnormal).toBe(
      true
    );
    expect(parseKeySlice("Anomalie: absence d'anomalie").abnormal).toBe(false);
    expect(parseKeySlice("Anomalie: aucune").abnormal).toBe(false);
  });

  it("parseKeySlice : extrait le numéro de coupe-clé malgré du texte", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    expect(parseKeySlice("Coupe-clé : coupe n° 47").keySliceNumber).toBe(47);
    expect(parseKeySlice("Anomalie: oui\nCoupe-clé:\n23").keySliceNumber).toBe(
      23
    );
  });

  it("parseKeySlice : NE confond PAS 'anomalies' (en phrase) avec l'étiquette 'Anomalie:' (anti fausse réassurance)", async () => {
    const { parseKeySlice } = await import("./aiPreanalysis");
    // Sortie réelle observée sur qwen2.5vl:7b : le mot "anomalies" apparaît dans
    // la Conclusion AVANT la vraie ligne d'étiquette. L'ancien regex matchait
    // "anomalies visibles" → abnormal=true à tort sur un examen NORMAL.
    const real =
      "Conclusion: Cette image semble être normale, sans anomalies visibles.\n\nAnomalie: non\n\nCoupe-clé: 1";
    expect(parseKeySlice(real).abnormal).toBe(false);
    // Inverse : une vraie anomalie reste détectée même si "normal" est mentionné ailleurs.
    const ab =
      "Conclusion: Parenchyme normal par ailleurs.\n\nAnomalie: oui\n\nCoupe-clé: 8";
    expect(parseKeySlice(ab).abnormal).toBe(true);
  });
});
