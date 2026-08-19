import { describe, it, expect, vi, afterEach } from "vitest";
import {
  groupByModality,
  stripPhiLike,
  startLearningAgent,
  stopLearningAgent,
} from "./learning";
import { ENV } from "../_core/env";

describe("agent apprentissage", () => {
  it("groupByModality applique le seuil (≥3)", () => {
    const items = [
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "CT", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
      { modality: "US", draft: "a", signed: "b" },
    ];
    const g = groupByModality(items, 3);
    expect(g.has("CT")).toBe(true);
    expect(g.has("US")).toBe(false);
  });
  it("stripPhiLike retire nom MAJUSCULE, date, gros nombre ; garde le médical", () => {
    const t =
      "POCINCI ZEHRA née le 24.12.1997 id 1029384 : épaississement zone jonctionnelle 12 mm";
    const c = stripPhiLike(t);
    expect(c).not.toMatch(/POCINCI|ZEHRA/);
    expect(c).not.toMatch(/24\.12\.1997/);
    expect(c).not.toMatch(/1029384/);
    expect(c).toMatch(/zone jonctionnelle 12 mm/);
  });
});

describe("startLearningAgent — planification de l'apprentissage", () => {
  const originalPollMs = ENV.learningPollMs;
  afterEach(() => {
    stopLearningAgent();
    (ENV as any).learningPollMs = originalPollMs;
    vi.useRealTimers();
  });

  it("n'exécute rien si LEARNING_POLL_MS <= 0 (opt-in désactivé par défaut)", () => {
    vi.useFakeTimers();
    (ENV as any).learningPollMs = 0;
    const run = vi.fn(async () => ({ proposed: 0 }));
    startLearningAgent(run);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("exécute runLearningAgent à l'intervalle quand activé", () => {
    vi.useFakeTimers();
    (ENV as any).learningPollMs = 1000;
    const run = vi.fn(async () => ({ proposed: 0 }));
    startLearningAgent(run);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
