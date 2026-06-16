import { describe, it, expect } from "vitest";
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
