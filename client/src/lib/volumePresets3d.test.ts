import { describe, it, expect } from "vitest";
import {
  PRESETS_3D,
  DEFAULT_PRESET_3D_ID,
  presetParId,
  presetsDisponibles,
  presetExiste,
} from "./volumePresets3d";

describe("PRESETS_3D", () => {
  it("expose des ids uniques", () => {
    const ids = PRESETS_3D.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a un libellé français pour chaque preset", () => {
    for (const p of PRESETS_3D) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.preset.length).toBeGreaterThan(0);
    }
  });

  it("contient un MIP et un défaut osseux", () => {
    expect(PRESETS_3D.some(p => p.mip)).toBe(true);
    expect(PRESETS_3D.find(p => p.id === DEFAULT_PRESET_3D_ID)?.preset).toBe(
      "CT-Bone"
    );
  });
});

describe("presetParId", () => {
  it("retourne le preset demandé", () => {
    expect(presetParId("mip").preset).toBe("CT-MIP");
    expect(presetParId("poumon").preset).toBe("CT-Lung");
  });

  it("se replie sur le défaut (Os) pour un id inconnu ou undefined", () => {
    expect(presetParId(undefined).id).toBe(DEFAULT_PRESET_3D_ID);
    expect(presetParId("nimporte-quoi").id).toBe(DEFAULT_PRESET_3D_ID);
  });
});

describe("presetsDisponibles", () => {
  it("renvoie la liste complète si aucun nom fourni", () => {
    expect(presetsDisponibles(undefined)).toEqual(PRESETS_3D);
    expect(presetsDisponibles([])).toEqual(PRESETS_3D);
  });

  it("filtre les presets absents mais garde toujours MIP", () => {
    const result = presetsDisponibles(["CT-Bone"]);
    expect(result.map(p => p.id).sort()).toEqual(["mip", "os"]);
  });

  it("ne renvoie jamais une liste vide (repli)", () => {
    const result = presetsDisponibles(["preset-inexistant"]);
    // Seul MIP survit au filtre nom → liste non vide
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(p => p.mip)).toBe(true);
  });
});

describe("presetExiste", () => {
  it("détecte la présence d'un preset par nom VTK", () => {
    expect(presetExiste("CT-Bone", ["CT-Bone", "CT-Lung"])).toBe(true);
    expect(presetExiste("CT-Bone", ["CT-Lung"])).toBe(false);
    expect(presetExiste("CT-Bone", null)).toBe(false);
  });
});
