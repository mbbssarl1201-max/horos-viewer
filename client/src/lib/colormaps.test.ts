import { describe, it, expect } from "vitest";
import {
  COLORMAPS,
  LUT_SIZE,
  isValidColormap,
  applyColormap,
  getColormapLut,
  type RGB,
} from "./colormaps";

const ALL_NAMES = COLORMAPS.map(c => c.name);

const REQUIRED = [
  "B&W",
  "B&W Inverse",
  "Hot Iron",
  "PET",
  "Rainbow",
  "Flow",
  "Spring",
  "Red",
  "Green",
  "Blue",
];

function isByte(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

describe("COLORMAPS (inventaire)", () => {
  it("contient au minimum les palettes requises façon Horos", () => {
    for (const name of REQUIRED) {
      expect(ALL_NAMES).toContain(name);
    }
  });
  it("chaque entrée a name + label non vides, label = name", () => {
    for (const c of COLORMAPS) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.label).toBe(c.name);
    }
  });
  it("noms uniques", () => {
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
  });
});

describe("isValidColormap", () => {
  it("vrai pour toutes les palettes de l'inventaire", () => {
    for (const name of ALL_NAMES) {
      expect(isValidColormap(name)).toBe(true);
    }
  });
  it("faux pour un nom inconnu", () => {
    expect(isValidColormap("Inconnu")).toBe(false);
    expect(isValidColormap("bw")).toBe(false); // casse
  });
  it("faux pour des types non-chaîne / valeurs vides", () => {
    expect(isValidColormap(null)).toBe(false);
    expect(isValidColormap(undefined)).toBe(false);
    expect(isValidColormap(42)).toBe(false);
    expect(isValidColormap("")).toBe(false);
    expect(isValidColormap({})).toBe(false);
  });
  it("n'est pas trompé par les propriétés héritées d'Object", () => {
    expect(isValidColormap("toString")).toBe(false);
    expect(isValidColormap("constructor")).toBe(false);
    expect(isValidColormap("hasOwnProperty")).toBe(false);
  });
});

describe("applyColormap (nominal)", () => {
  it("renvoie un triplet d'octets valides pour chaque palette", () => {
    for (const name of ALL_NAMES) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [r, g, b] = applyColormap(name, t);
        expect(isByte(r)).toBe(true);
        expect(isByte(g)).toBe(true);
        expect(isByte(b)).toBe(true);
      }
    }
  });

  it("B&W : noir en 0, blanc en 1, gris au milieu", () => {
    expect(applyColormap("B&W", 0)).toEqual([0, 0, 0]);
    expect(applyColormap("B&W", 1)).toEqual([255, 255, 255]);
    const mid = applyColormap("B&W", 0.5);
    expect(mid[0]).toBe(mid[1]);
    expect(mid[1]).toBe(mid[2]);
    expect(mid[0]).toBeCloseTo(128, -1);
  });

  it("B&W Inverse : blanc en 0, noir en 1 (miroir de B&W)", () => {
    expect(applyColormap("B&W Inverse", 0)).toEqual([255, 255, 255]);
    expect(applyColormap("B&W Inverse", 1)).toEqual([0, 0, 0]);
  });

  it("Red/Green/Blue : canal pur isolé", () => {
    expect(applyColormap("Red", 1)).toEqual([255, 0, 0]);
    expect(applyColormap("Red", 0)).toEqual([0, 0, 0]);
    expect(applyColormap("Green", 1)).toEqual([0, 255, 0]);
    expect(applyColormap("Blue", 1)).toEqual([0, 0, 255]);
  });

  it("Hot Iron : démarre en noir, finit en blanc, monte en rouge tôt", () => {
    expect(applyColormap("Hot Iron", 0)).toEqual([0, 0, 0]);
    expect(applyColormap("Hot Iron", 1)).toEqual([255, 255, 255]);
    const early = applyColormap("Hot Iron", 0.1);
    expect(early[0]).toBeGreaterThan(early[2]); // plus de rouge que de bleu
  });

  it("PET : noir → … → blanc", () => {
    expect(applyColormap("PET", 0)).toEqual([0, 0, 0]);
    expect(applyColormap("PET", 1)).toEqual([255, 255, 255]);
  });

  it("Rainbow : bleu en 0, rouge en 1", () => {
    expect(applyColormap("Rainbow", 0)).toEqual([0, 0, 255]);
    expect(applyColormap("Rainbow", 1)).toEqual([255, 0, 0]);
  });

  it("Flow : bleu en 0, noir au centre, rouge en 1", () => {
    expect(applyColormap("Flow", 0)).toEqual([0, 0, 255]);
    expect(applyColormap("Flow", 0.5)).toEqual([0, 0, 0]);
    expect(applyColormap("Flow", 1)).toEqual([255, 0, 0]);
  });

  it("Spring : magenta en 0, jaune en 1", () => {
    expect(applyColormap("Spring", 0)).toEqual([255, 0, 255]);
    expect(applyColormap("Spring", 1)).toEqual([255, 255, 0]);
  });
});

describe("applyColormap (bords & dégénérés)", () => {
  it("borne t < 0 à 0 et t > 1 à 1", () => {
    expect(applyColormap("B&W", -5)).toEqual(applyColormap("B&W", 0));
    expect(applyColormap("B&W", 9)).toEqual(applyColormap("B&W", 1));
  });
  it("NaN traité comme 0", () => {
    expect(applyColormap("B&W", NaN)).toEqual([0, 0, 0]);
  });
  it("déterministe : même entrée → même sortie", () => {
    expect(applyColormap("PET", 0.42)).toEqual(applyColormap("PET", 0.42));
  });
  it("lève pour une palette inconnue", () => {
    expect(() => applyColormap("Nope", 0.5)).toThrow();
  });
});

describe("getColormapLut", () => {
  it("renvoie un Uint8ClampedArray de 256*3 pour chaque palette", () => {
    for (const name of ALL_NAMES) {
      const lut = getColormapLut(name);
      expect(lut).toBeInstanceOf(Uint8ClampedArray);
      expect(lut.length).toBe(LUT_SIZE * 3);
      expect(lut.length).toBe(768);
    }
  });

  it("toutes les composantes sont des octets [0..255]", () => {
    const lut = getColormapLut("PET");
    for (let i = 0; i < lut.length; i++) {
      expect(isByte(lut[i])).toBe(true);
    }
  });

  it("première et dernière entrée cohérentes avec applyColormap", () => {
    for (const name of ALL_NAMES) {
      const lut = getColormapLut(name);
      const first: RGB = [lut[0], lut[1], lut[2]];
      const lastO = (LUT_SIZE - 1) * 3;
      const last: RGB = [lut[lastO], lut[lastO + 1], lut[lastO + 2]];
      expect(first).toEqual(applyColormap(name, 0));
      expect(last).toEqual(applyColormap(name, 1));
    }
  });

  it("chaque index i correspond à applyColormap(t = i/255)", () => {
    const name = "Rainbow";
    const lut = getColormapLut(name);
    for (const i of [0, 1, 64, 128, 200, 255]) {
      const o = i * 3;
      expect([lut[o], lut[o + 1], lut[o + 2]]).toEqual(
        applyColormap(name, i / (LUT_SIZE - 1))
      );
    }
  });

  it("B&W : LUT = rampe linéaire de gris (diagonale)", () => {
    const lut = getColormapLut("B&W");
    expect([lut[0], lut[1], lut[2]]).toEqual([0, 0, 0]);
    const lastO = 255 * 3;
    expect([lut[lastO], lut[lastO + 1], lut[lastO + 2]]).toEqual([
      255, 255, 255,
    ]);
    // r=g=b sur toute la table
    for (let i = 0; i < LUT_SIZE; i++) {
      const o = i * 3;
      expect(lut[o]).toBe(lut[o + 1]);
      expect(lut[o + 1]).toBe(lut[o + 2]);
    }
  });

  it("B&W et B&W Inverse sont miroirs l'une de l'autre", () => {
    const bw = getColormapLut("B&W");
    const inv = getColormapLut("B&W Inverse");
    for (let i = 0; i < LUT_SIZE; i++) {
      const o = i * 3;
      const j = (LUT_SIZE - 1 - i) * 3;
      expect(bw[o]).toBe(inv[j]);
    }
  });

  it("déterministe : deux appels donnent des tables identiques", () => {
    const a = getColormapLut("Hot Iron");
    const b = getColormapLut("Hot Iron");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("lève pour une palette inconnue", () => {
    expect(() => getColormapLut("Inconnu")).toThrow();
  });
});
