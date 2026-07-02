import { describe, it, expect } from "vitest";
import { isFableModel, REFUSAL_FALLBACK_MODEL } from "./anthropicModel";

describe("isFableModel", () => {
  it("reconnaît la famille Fable / Mythos", () => {
    expect(isFableModel("claude-fable-5")).toBe(true);
    expect(isFableModel("claude-mythos-5")).toBe(true);
    expect(isFableModel("claude-mythos-preview")).toBe(true);
  });

  it("exclut Opus / Sonnet / Haiku et les valeurs vides", () => {
    expect(isFableModel("claude-opus-4-8")).toBe(false);
    expect(isFableModel("claude-sonnet-5")).toBe(false);
    expect(isFableModel("claude-haiku-4-5")).toBe(false);
    expect(isFableModel("")).toBe(false);
    expect(isFableModel(null)).toBe(false);
    expect(isFableModel(undefined)).toBe(false);
  });

  it("le modèle de repli n'est pas lui-même un modèle Fable", () => {
    expect(isFableModel(REFUSAL_FALLBACK_MODEL)).toBe(false);
  });
});
