import { describe, it, expect, vi, beforeEach } from "vitest";

// ENV mockable : on contrôle DETECTOR_PROVIDER par test.
// vi.hoisted → disponible dans la factory vi.mock (hoistée en tête de fichier).
const env = vi.hoisted(() => ({
  detectorProvider: "",
  detectorApiUrl: "",
  detectorApiKey: "",
})) as Record<string, string>;
vi.mock("../_core/env", () => ({ ENV: env }));

import { detectorConfigured, analyzeStudyWithDetector } from "./detectors";

describe("détecteur certifié — connecteur", () => {
  beforeEach(() => {
    env.detectorProvider = "";
    env.detectorApiUrl = "";
    env.detectorApiKey = "";
    vi.restoreAllMocks();
  });

  it("désactivé par défaut (aucune config)", async () => {
    expect(detectorConfigured()).toBe(false);
    const r = await analyzeStudyWithDetector(1);
    expect(r.enabled).toBe(false);
    expect(r.certified).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("mode mock = activé mais NON certifié, findings factices", async () => {
    env.detectorProvider = "mock";
    expect(detectorConfigured()).toBe(true);
    const r = await analyzeStudyWithDetector(1, 7);
    expect(r.enabled).toBe(true);
    expect(r.certified).toBe(false); // jamais certifié en mock
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("mode http exige URL + clé pour être configuré", () => {
    env.detectorProvider = "http";
    expect(detectorConfigured()).toBe(false);
    env.detectorApiUrl = "https://detect.example.ch";
    env.detectorApiKey = "k";
    expect(detectorConfigured()).toBe(true);
  });

  it("mode http : findings normalisés, marqués certifiés", async () => {
    env.detectorProvider = "http";
    env.detectorApiUrl = "https://detect.example.ch";
    env.detectorApiKey = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          findings: [
            {
              app: "BoneView",
              label: "Fracture",
              confidence: 0.92,
              bodyPart: "Poignet",
            },
          ],
        }),
      }))
    );
    const r = await analyzeStudyWithDetector(42, 3);
    expect(r.certified).toBe(true);
    expect(r.findings[0].label).toBe("Fracture");
    expect(r.findings[0].confidence).toBeCloseTo(0.92);
  });

  it("mode http : erreur HTTP = pas de finding mais reste certifié", async () => {
    env.detectorProvider = "http";
    env.detectorApiUrl = "https://detect.example.ch";
    env.detectorApiKey = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }))
    );
    const r = await analyzeStudyWithDetector(42);
    expect(r.findings).toEqual([]);
    expect(r.note).toContain("503");
  });
});
