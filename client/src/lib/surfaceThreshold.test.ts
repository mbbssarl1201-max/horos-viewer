import { describe, it, expect } from "vitest";
import {
  SURFACE_PRESETS,
  classifyVoxel,
  suggestIsoForModality,
  presetsForModality,
  getSurfacePresetById,
  type SurfacePreset,
} from "./surfaceThreshold";

describe("SURFACE_PRESETS (catalogue)", () => {
  it("contient au moins les presets clés (os, peau, poumon)", () => {
    const ids = SURFACE_PRESETS.map(p => p.id);
    expect(ids).toContain("ct-bone");
    expect(ids).toContain("ct-skin");
    expect(ids).toContain("ct-lung");
  });

  it("a des ids uniques", () => {
    const ids = SURFACE_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a des libellés et isoValue finis pour chaque preset", () => {
    for (const p of SURFACE_PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(p.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.isoValue)).toBe(true);
      expect(["CT", "MR", "PT", "ANY"]).toContain(p.modality);
    }
  });

  it("place l'os CT ~300 et la peau CT ~-300", () => {
    const bone = SURFACE_PRESETS.find(p => p.id === "ct-bone") as SurfacePreset;
    const skin = SURFACE_PRESETS.find(p => p.id === "ct-skin") as SurfacePreset;
    expect(bone.isoValue).toBe(300);
    expect(skin.isoValue).toBe(-300);
  });

  it("ordonne os dense > os > tissu mou > angio (cohérence HU)", () => {
    const byId = (id: string) =>
      (SURFACE_PRESETS.find(p => p.id === id) as SurfacePreset).isoValue;
    expect(byId("ct-bone-dense")).toBeGreaterThan(byId("ct-bone"));
    expect(byId("ct-bone")).toBeGreaterThan(byId("ct-angio"));
    expect(byId("ct-angio")).toBeGreaterThan(byId("ct-soft"));
    expect(byId("ct-soft")).toBeGreaterThan(byId("ct-lung"));
  });
});

describe("classifyVoxel", () => {
  it("inclut un voxel au-dessus du seuil", () => {
    expect(classifyVoxel(400, 300)).toBe(true);
  });

  it("exclut un voxel sous le seuil", () => {
    expect(classifyVoxel(100, 300)).toBe(false);
  });

  it("inclut un voxel exactement au seuil (convention ≥ inclusive)", () => {
    expect(classifyVoxel(300, 300)).toBe(true);
  });

  it("gère les seuils négatifs (peau)", () => {
    expect(classifyVoxel(-200, -300)).toBe(true);
    expect(classifyVoxel(-400, -300)).toBe(false);
    expect(classifyVoxel(-300, -300)).toBe(true);
  });

  it("gère le seuil zéro", () => {
    expect(classifyVoxel(0, 0)).toBe(true);
    expect(classifyVoxel(-0.001, 0)).toBe(false);
  });

  it("renvoie false si la valeur est NaN", () => {
    expect(classifyVoxel(NaN, 300)).toBe(false);
  });

  it("renvoie false si le seuil est NaN", () => {
    expect(classifyVoxel(400, NaN)).toBe(false);
  });

  it("renvoie false sur Infinity (valeur ou seuil)", () => {
    expect(classifyVoxel(Infinity, 300)).toBe(false);
    expect(classifyVoxel(400, Infinity)).toBe(false);
    expect(classifyVoxel(-Infinity, -300)).toBe(false);
  });

  it("est déterministe sur des valeurs fractionnaires", () => {
    expect(classifyVoxel(300.0001, 300)).toBe(true);
    expect(classifyVoxel(299.9999, 300)).toBe(false);
  });
});

describe("suggestIsoForModality", () => {
  it("CT → seuil os (300)", () => {
    expect(suggestIsoForModality("CT")).toBe(300);
  });

  it("MR → seuil générique MR", () => {
    expect(suggestIsoForModality("MR")).toBe(100);
  });

  it("PT et PET → seuil générique PET", () => {
    expect(suggestIsoForModality("PT")).toBe(1);
    expect(suggestIsoForModality("PET")).toBe(1);
  });

  it("est insensible à la casse et aux espaces", () => {
    expect(suggestIsoForModality(" ct ")).toBe(300);
    expect(suggestIsoForModality("Ct")).toBe(300);
    expect(suggestIsoForModality("mr")).toBe(100);
  });

  it("modalité inconnue → repli sur os CT (300)", () => {
    expect(suggestIsoForModality("US")).toBe(300);
    expect(suggestIsoForModality("XYZ")).toBe(300);
  });

  it("null / undefined / vide → repli sur os CT (300)", () => {
    expect(suggestIsoForModality(null)).toBe(300);
    expect(suggestIsoForModality(undefined)).toBe(300);
    expect(suggestIsoForModality("")).toBe(300);
  });

  it("renvoie toujours un nombre fini", () => {
    for (const m of ["CT", "MR", "PT", "PET", "", "??", null, undefined]) {
      expect(Number.isFinite(suggestIsoForModality(m))).toBe(true);
    }
  });
});

describe("presetsForModality", () => {
  it("CT → uniquement des presets CT (pas de MR/PT)", () => {
    const out = presetsForModality("CT");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(p => p.modality === "CT")).toBe(true);
  });

  it("MR → seulement les presets MR", () => {
    const out = presetsForModality("MR");
    expect(out.every(p => p.modality === "MR")).toBe(true);
    expect(out.some(p => p.id === "mr-generic")).toBe(true);
  });

  it("PET traité comme PT", () => {
    const pt = presetsForModality("PT");
    const pet = presetsForModality("PET");
    expect(pet.map(p => p.id)).toEqual(pt.map(p => p.id));
    expect(pt.some(p => p.id === "pt-generic")).toBe(true);
  });

  it("insensible à la casse et aux espaces", () => {
    expect(presetsForModality(" ct ").map(p => p.id)).toEqual(
      presetsForModality("CT").map(p => p.id)
    );
  });

  it("modalité inconnue / null → liste vide (aucun preset ANY défini)", () => {
    expect(presetsForModality("US")).toEqual([]);
    expect(presetsForModality(null)).toEqual([]);
    expect(presetsForModality(undefined)).toEqual([]);
    expect(presetsForModality("")).toEqual([]);
  });
});

describe("getSurfacePresetById", () => {
  it("trouve un preset existant", () => {
    const p = getSurfacePresetById("ct-bone");
    expect(p).not.toBeNull();
    expect(p?.isoValue).toBe(300);
  });

  it("renvoie null pour un id inconnu", () => {
    expect(getSurfacePresetById("nope")).toBeNull();
  });

  it("renvoie null pour null / undefined", () => {
    expect(getSurfacePresetById(null)).toBeNull();
    expect(getSurfacePresetById(undefined)).toBeNull();
  });
});

describe("cohérence inter-fonctions", () => {
  it("le seuil suggéré pour CT correspond à un preset existant", () => {
    const iso = suggestIsoForModality("CT");
    expect(SURFACE_PRESETS.some(p => p.isoValue === iso)).toBe(true);
  });

  it("classifyVoxel avec le seuil suggéré CT sépare os et tissu mou", () => {
    const iso = suggestIsoForModality("CT");
    expect(classifyVoxel(700, iso)).toBe(true); // os cortical
    expect(classifyVoxel(40, iso)).toBe(false); // tissu mou
    expect(classifyVoxel(-1000, iso)).toBe(false); // air
  });
});
