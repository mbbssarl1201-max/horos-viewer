import { describe, it, expect } from "vitest";
import { AGENTS, getAgentSpec } from "./registry";

describe("registre d'agents", () => {
  it("contient les 3 agents existants", () => {
    expect(AGENTS.map(a => a.key).sort()).toEqual([
      "copilote",
      "qualite",
      "redacteur",
    ]);
  });
  it("chaque agent a des outils, accès et au moins un KPI", () => {
    for (const a of AGENTS) {
      expect(a.tools.length).toBeGreaterThan(0);
      expect(a.access.length).toBeGreaterThan(0);
      expect(a.kpis.length).toBeGreaterThan(0);
    }
  });
  it("getAgentSpec renvoie la fiche ou null", () => {
    expect(getAgentSpec("redacteur")?.name).toBeTruthy();
    expect(getAgentSpec("inconnu")).toBeNull();
  });
});
