import { describe, it, expect } from "vitest";
import {
  configuredProviders,
  certifiedAiInventory,
  runCertifiedAnalysis,
  providersForModality,
} from "./externalAI";

// En environnement de test, AUCUNE variable d'env fournisseur n'est définie →
// on valide le comportement « rien branché » (le cas par défaut, le plus
// important pour la sécurité : aucun moteur tiers ne s'active sans contrat/clé).
describe("externalAI (moteurs certifiés tiers)", () => {
  it("par défaut : AUCUN fournisseur configuré (rien ne s'active sans contrat)", () => {
    expect(configuredProviders()).toHaveLength(0);
  });

  it("runCertifiedAnalysis renvoie null quand rien n'est branché (→ repli sur aide interne)", async () => {
    const r = await runCertifiedAnalysis({
      studyId: 1,
      modality: "US",
      studyInstanceUid: "1.2.3",
    });
    expect(r).toBeNull();
  });

  it("providersForModality vide tant que rien n'est configuré", () => {
    expect(providersForModality("XR")).toHaveLength(0);
    expect(providersForModality("CT")).toHaveLength(0);
  });

  it("inventaire : liste TOUS les moteurs dispo (pour l'UI), avec modalités + réglementaire", () => {
    const inv = certifiedAiInventory();
    expect(inv.length).toBeGreaterThanOrEqual(5);
    // Tous non configurés en test.
    expect(inv.every(p => p.configured === false)).toBe(true);

    const koios = inv.find(p => p.name.includes("Koios"));
    expect(koios).toBeTruthy();
    expect(koios!.modalities).toContain("US"); // écho mammaire
    expect(koios!.regulatory).toMatch(/CE|FDA/);

    const gleamer = inv.find(p => p.name.includes("Gleamer"));
    expect(gleamer!.modalities).toContain("XR"); // radio fractures

    // Les marketplaces couvrent toutes les modalités (intégration unique → N modèles).
    const carpl = inv.find(p => p.name.includes("CARPL"));
    expect(carpl!.modalities).toEqual(
      expect.arrayContaining(["XR", "CT", "MR", "US", "MG"])
    );
  });
});
