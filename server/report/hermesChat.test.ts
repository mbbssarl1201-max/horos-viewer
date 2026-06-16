import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HERMES_SYSTEM_PROMPT,
  buildHermesContext,
  assembleMessages,
} from "./hermesChat";

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
