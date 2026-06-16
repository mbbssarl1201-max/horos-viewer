import { describe, it, expect } from "vitest";
import {
  WINDOW_PRESETS,
  getPresetsForModality,
  findPreset,
  type WindowPreset,
} from "./windowPresets";

describe("WINDOW_PRESETS (catalogue)", () => {
  it("contient des presets et chacun est bien formé", () => {
    expect(WINDOW_PRESETS.length).toBeGreaterThan(0);
    for (const p of WINDOW_PRESETS) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe("string");
      expect(p.label.length).toBeGreaterThan(0);
      expect(["CT", "MR", "PT", "ANY"]).toContain(p.modality);
      // wc/ww sont soit des nombres finis, soit null (cas Default).
      if (p.wc !== null) expect(Number.isFinite(p.wc)).toBe(true);
      if (p.ww !== null) expect(Number.isFinite(p.ww)).toBe(true);
    }
  });

  it("a des id uniques", () => {
    const ids = WINDOW_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("le preset Default a wc/ww null et modalité ANY", () => {
    const def = WINDOW_PRESETS.find(p => p.id === "default");
    expect(def).toBeDefined();
    expect(def?.wc).toBeNull();
    expect(def?.ww).toBeNull();
    expect(def?.modality).toBe("ANY");
  });

  it("expose les presets CT Horos attendus avec les bonnes valeurs", () => {
    const byId = (id: string): WindowPreset | undefined =>
      WINDOW_PRESETS.find(p => p.id === id);

    expect(byId("ct-abdomen")).toMatchObject({
      wc: 40,
      ww: 400,
      modality: "CT",
    });
    expect(byId("ct-bone")).toMatchObject({
      wc: 300,
      ww: 1500,
      modality: "CT",
    });
    expect(byId("ct-bone-dense")).toMatchObject({
      wc: 500,
      ww: 2000,
      modality: "CT",
    });
    expect(byId("ct-lung")).toMatchObject({
      wc: -600,
      ww: 1500,
      modality: "CT",
    });
    expect(byId("ct-brain")).toMatchObject({ wc: 40, ww: 80, modality: "CT" });
    expect(byId("ct-soft")).toMatchObject({ wc: 40, ww: 350, modality: "CT" });
    expect(byId("ct-liver")?.modality).toBe("CT");
    expect(byId("ct-mediastinum")?.modality).toBe("CT");
    expect(byId("ct-angio")?.modality).toBe("CT");
  });

  it("toutes les largeurs WW renseignées sont strictement positives", () => {
    for (const p of WINDOW_PRESETS) {
      if (p.ww !== null) expect(p.ww).toBeGreaterThan(0);
    }
  });
});

describe("getPresetsForModality", () => {
  it("CT renvoie les presets CT + les presets ANY", () => {
    const list = getPresetsForModality("CT");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(p => p.modality === "CT" || p.modality === "ANY")).toBe(
      true
    );
    // contient au moins un CT et le Default (ANY).
    expect(list.some(p => p.modality === "CT")).toBe(true);
    expect(list.some(p => p.id === "default")).toBe(true);
  });

  it("MR renvoie les presets MR + ANY, pas de CT", () => {
    const list = getPresetsForModality("MR");
    expect(list.some(p => p.modality === "MR")).toBe(true);
    expect(list.every(p => p.modality !== "CT")).toBe(true);
    expect(list.some(p => p.id === "default")).toBe(true);
  });

  it("tolère la casse et les espaces", () => {
    const a = getPresetsForModality("ct");
    const b = getPresetsForModality("  Ct  ");
    const ref = getPresetsForModality("CT");
    expect(a).toEqual(ref);
    expect(b).toEqual(ref);
  });

  it("modalité inconnue → seulement les presets ANY", () => {
    const list = getPresetsForModality("US");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(p => p.modality === "ANY")).toBe(true);
  });

  it("préserve l'ordre du catalogue", () => {
    const list = getPresetsForModality("CT");
    const expected = WINDOW_PRESETS.filter(
      p => p.modality === "ANY" || p.modality === "CT"
    );
    expect(list.map(p => p.id)).toEqual(expected.map(p => p.id));
  });

  it("renvoie une nouvelle liste (mutation sans effet de bord)", () => {
    const list = getPresetsForModality("CT");
    const lenBefore = WINDOW_PRESETS.length;
    list.pop();
    expect(WINDOW_PRESETS.length).toBe(lenBefore);
  });

  it("dégénérés : null / undefined / vide → presets ANY uniquement", () => {
    for (const m of [null, undefined, "", "   "]) {
      const list = getPresetsForModality(m as unknown);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every(p => p.modality === "ANY")).toBe(true);
    }
  });
});

describe("findPreset", () => {
  it("trouve un preset existant", () => {
    const p = findPreset("ct-lung");
    expect(p).toBeDefined();
    expect(p?.wc).toBe(-600);
    expect(p?.ww).toBe(1500);
  });

  it("trouve le preset Default", () => {
    expect(findPreset("default")?.wc).toBeNull();
  });

  it("id inconnu → undefined", () => {
    expect(findPreset("inexistant")).toBeUndefined();
  });

  it("dégénérés : null / undefined / vide → undefined", () => {
    expect(findPreset(null)).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
    expect(findPreset("")).toBeUndefined();
  });

  it("comparaison stricte sur l'id (casse sensible)", () => {
    expect(findPreset("CT-LUNG")).toBeUndefined();
  });

  it("chaque id du catalogue est retrouvable", () => {
    for (const p of WINDOW_PRESETS) {
      expect(findPreset(p.id)?.id).toBe(p.id);
    }
  });
});
