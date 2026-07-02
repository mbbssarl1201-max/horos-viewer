import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HERMES_SYSTEM_PROMPT,
  buildHermesContext,
  assembleMessages,
  prepareHermesChat,
} from "./hermesChat";
import * as embeddings from "../knowledge/embeddings";
import * as store from "../knowledge/store";
import * as db from "../db";

describe("buildHermesContext", () => {
  it("inclut modalité/examen/indication + sections du CR", () => {
    const ctx = buildHermesContext(
      { modality: "CT", studyDescription: "Scanner thorax" },
      {
        indication: "Dyspnée",
        technique: "TDM thoracique",
        resultats: "Nodule LSD 8mm",
        conclusion: "À surveiller",
      }
    );
    expect(ctx).toMatch(/CT/);
    expect(ctx).toMatch(/Scanner thorax/);
    expect(ctx).toMatch(/Dyspnée/);
    expect(ctx).toMatch(/Nodule LSD 8mm/);
    expect(ctx).toMatch(/À surveiller/);
  });
  it("sans CR ni champs → marqueurs 'non renseigné' et mention d'absence", () => {
    const ctx = buildHermesContext(null, null);
    expect(ctx).toMatch(/non renseignée?/i);
    expect(ctx).toMatch(/Aucun compte-rendu/i);
  });
});

describe("assembleMessages", () => {
  it("system en 1er, contexte en 2e, puis l'historique dans l'ordre", () => {
    const msgs = assembleMessages("CTX", [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
    ]);
    expect(msgs[0]).toEqual({ role: "system", content: HERMES_SYSTEM_PROMPT });
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toMatch(/CTX/);
    expect(msgs[2]).toEqual({ role: "user", content: "Q1" });
    expect(msgs[4]).toEqual({ role: "user", content: "Q2" });
  });
  it("tronque l'historique aux derniers `maxTurns` tours", () => {
    const hist = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const msgs = assembleMessages("CTX", hist, 5);
    expect(msgs).toHaveLength(7);
    expect(msgs[2]).toEqual({ role: "user", content: "m15" });
  });
  it("avec bloc connaissances → message DONNÉES inséré après le contexte", () => {
    const hist = [
      { role: "user" as const, content: "Q1" },
      { role: "assistant" as const, content: "R1" },
    ];
    const msgs = assembleMessages("CTX", hist, 12, "BLOC-CONNAISSANCES");
    expect(msgs).toHaveLength(5);
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toContain("BLOC-CONNAISSANCES");
    expect(msgs[3]).toEqual({ role: "user", content: "Q1" });
  });
  it("bloc connaissances vide → traité comme absent", () => {
    const hist = [
      { role: "user" as const, content: "Q1" },
      { role: "assistant" as const, content: "R1" },
    ];
    const msgs = assembleMessages("CTX", hist, 12, "");
    expect(msgs).toHaveLength(4);
  });
});

describe("chatViaOllama", () => {
  beforeEach(() => {
    process.env.OLLAMA_URL = "http://ollama-test:11434";
    process.env.OLLAMA_TEXT_MODEL = "qwen2.5:3b";
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("envoie les messages à /api/chat et renvoie le contenu", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: "Réponse Hermès" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { chatViaOllama } = await import("./hermesChat");
    const out = await chatViaOllama([
      { role: "system", content: "S" },
      { role: "user", content: "Q" },
    ]);
    expect(out).toBe("Réponse Hermès");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.model).toBe("qwen2.5:3b");
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "S" });
  });
});

describe("prepareHermesChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(db, "countRecentAccess").mockResolvedValue(0);
    vi.spyOn(db, "getStudyById").mockResolvedValue({
      id: 7,
      modality: "MR",
      studyDescription: "IRM cérébrale",
    } as any);
    vi.spyOn(db, "getReportByStudy").mockResolvedValue(null as any);
    vi.spyOn(embeddings, "embedText").mockResolvedValue([1, 0, 0]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renvoie des sources quand un chunk dépasse le seuil", async () => {
    vi.spyOn(store, "searchSimilar").mockResolvedValue([
      { source: "proto.md", heading: "T1", content: "ref", score: 0.9 },
      { source: "x.md", heading: "Z", content: "bruit", score: 0.2 },
    ]);
    const out = await prepareHermesChat(
      { studyId: 7, messages: [{ role: "user", content: "rehaussement ?" }] },
      { user: { id: 1 } }
    );
    expect(out.sources.map(s => s.source)).toEqual(["proto.md"]);
    expect(out.messages.some(m => m.content.includes("ref"))).toBe(true);
  });

  it("aucune source pertinente → sources vide, pas de bloc", async () => {
    vi.spyOn(store, "searchSimilar").mockResolvedValue([
      { source: "x.md", heading: "Z", content: "bruit", score: 0.2 },
    ]);
    const out = await prepareHermesChat(
      { studyId: 7, messages: [{ role: "user", content: "?" }] },
      { user: { id: 1 } }
    );
    expect(out.sources).toEqual([]);
    expect(out.messages.some(m => m.content.includes("bruit"))).toBe(false);
  });

  it("RAG fail-open : embedText jette → sources vide, pas d'erreur", async () => {
    vi.spyOn(embeddings, "embedText").mockRejectedValue(
      new Error("ollama down")
    );
    const out = await prepareHermesChat(
      { studyId: 7, messages: [{ role: "user", content: "?" }] },
      { user: { id: 1 } }
    );
    expect(out.sources).toEqual([]);
  });
});
