import { describe, it, expect } from "vitest";
import {
  applyLinearVoi,
  applySigmoidVoi,
  voiToLut,
  type VoiLutFunction,
} from "./voiLut";

describe("applyLinearVoi", () => {
  // Fenêtre de référence : WC=40, WW=400 → bornes [40 - 199.5, 40 + 199.5].
  const wc = 40;
  const ww = 400;
  const below = wc - (ww - 1) / 2; // -159.5
  const above = wc + (ww - 1) / 2; // 239.5

  it("renvoie 0 strictement sous (ou à) la borne basse", () => {
    expect(applyLinearVoi(below, wc, ww)).toBe(0);
    expect(applyLinearVoi(below - 100, wc, ww)).toBe(0);
    expect(applyLinearVoi(-1000, wc, ww)).toBe(0);
  });

  it("renvoie 1 strictement au-dessus de la borne haute", () => {
    expect(applyLinearVoi(above + 0.001, wc, ww)).toBe(1);
    expect(applyLinearVoi(above + 100, wc, ww)).toBe(1);
    expect(applyLinearVoi(1000, wc, ww)).toBe(1);
  });

  it("renvoie ~0.5 au centre de la fenêtre", () => {
    // Formule DICOM : y(wc) = 0.5 + 0.5/(ww-1) (léger biais du +0.5 normatif).
    const expected = (wc - (wc - 0.5)) / (ww - 1) + 0.5;
    expect(applyLinearVoi(wc, wc, ww)).toBeCloseTo(expected, 9);
    expect(applyLinearVoi(wc, wc, ww)).toBeCloseTo(0.5, 2);
  });

  it("est monotone croissante sur la fenêtre", () => {
    let prev = -1;
    for (let x = below; x <= above; x += 5) {
      const y = applyLinearVoi(x, wc, ww);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it("respecte la formule DICOM en un point intermédiaire", () => {
    // x = 140 : ((140 - (40 - 0.5)) / (400 - 1)) + 0.5
    const expected = (140 - (wc - 0.5)) / (ww - 1) + 0.5;
    expect(applyLinearVoi(140, wc, ww)).toBeCloseTo(expected, 9);
  });

  it("sortie toujours bornée dans [0,1]", () => {
    for (let x = -2000; x <= 2000; x += 37) {
      const y = applyLinearVoi(x, wc, ww);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("WW < 1 est forcée à 1 → seuil binaire centré sur wc", () => {
    // width=1 → below=above=wc ; x<=wc → 0, x>wc → 1.
    expect(applyLinearVoi(wc - 0.5, wc, 0)).toBe(0);
    expect(applyLinearVoi(wc, wc, 0)).toBe(0); // x <= below(=wc)
    expect(applyLinearVoi(wc + 0.5, wc, 0)).toBe(1);
    expect(applyLinearVoi(wc, wc, -50)).toBe(0);
    expect(applyLinearVoi(wc + 1, wc, -50)).toBe(1);
  });

  it("gère un window center négatif", () => {
    // y(wc) = 0.5 + 0.5/(ww-1) = 0.5 + 0.5/99.
    expect(applyLinearVoi(-500, -500, 100)).toBeCloseTo(0.5 + 0.5 / 99, 9);
    expect(applyLinearVoi(-600, -500, 100)).toBe(0);
    expect(applyLinearVoi(-400, -500, 100)).toBe(1);
  });
});

describe("applySigmoidVoi", () => {
  const wc = 40;
  const ww = 400;

  it("renvoie exactement 0.5 au centre", () => {
    expect(applySigmoidVoi(wc, wc, ww)).toBeCloseTo(0.5, 9);
  });

  it("respecte la formule DICOM (facteur 4)", () => {
    const x = 240;
    const expected = 1 / (1 + Math.exp((-4 * (x - wc)) / ww));
    expect(applySigmoidVoi(x, wc, ww)).toBeCloseTo(expected, 9);
  });

  it("est strictement croissante", () => {
    let prev = -1;
    for (let x = -2000; x <= 2000; x += 50) {
      const y = applySigmoidVoi(x, wc, ww);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it("approche 0 et 1 asymptotiquement (sans jamais sortir de [0,1])", () => {
    expect(applySigmoidVoi(-100000, wc, ww)).toBeGreaterThanOrEqual(0);
    expect(applySigmoidVoi(-100000, wc, ww)).toBeLessThan(0.001);
    expect(applySigmoidVoi(100000, wc, ww)).toBeLessThanOrEqual(1);
    expect(applySigmoidVoi(100000, wc, ww)).toBeGreaterThan(0.999);
  });

  it("est symétrique autour du centre : y(wc+d) = 1 - y(wc-d)", () => {
    for (const d of [10, 50, 123, 400]) {
      const hi = applySigmoidVoi(wc + d, wc, ww);
      const lo = applySigmoidVoi(wc - d, wc, ww);
      expect(hi).toBeCloseTo(1 - lo, 9);
    }
  });

  it("dégénère en seuil dur quand WW <= 0", () => {
    expect(applySigmoidVoi(wc - 1, wc, 0)).toBe(0);
    expect(applySigmoidVoi(wc, wc, 0)).toBe(0.5);
    expect(applySigmoidVoi(wc + 1, wc, 0)).toBe(1);
    expect(applySigmoidVoi(wc - 1, wc, -10)).toBe(0);
    expect(applySigmoidVoi(wc + 1, wc, -10)).toBe(1);
  });

  it("sortie toujours bornée dans [0,1]", () => {
    for (let x = -5000; x <= 5000; x += 91) {
      const y = applySigmoidVoi(x, wc, ww);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("une fenêtre plus étroite donne une pente plus raide", () => {
    const d = 50;
    const narrow = applySigmoidVoi(wc + d, wc, 100);
    const wide = applySigmoidVoi(wc + d, wc, 1000);
    // À distance d fixe du centre, la fenêtre étroite sature plus vite.
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("voiToLut", () => {
  it("produit une Float32Array de la taille demandée", () => {
    const lut = voiToLut(40, 400, "LINEAR", 256);
    expect(lut).toBeInstanceOf(Float32Array);
    expect(lut.length).toBe(256);
  });

  it("utilise 256 entrées par défaut", () => {
    expect(voiToLut(0, 100, "LINEAR").length).toBe(256);
  });

  it("borne le nombre d'entrées à au moins 2", () => {
    expect(voiToLut(0, 100, "LINEAR", 1).length).toBe(2);
    expect(voiToLut(0, 100, "LINEAR", 0).length).toBe(2);
    expect(voiToLut(0, 100, "LINEAR", -5).length).toBe(2);
  });

  it("tronque un steps fractionnaire", () => {
    expect(voiToLut(0, 100, "LINEAR", 10.9).length).toBe(10);
  });

  it("LINEAR : première entrée ~0, dernière ~1, milieu ~0.5", () => {
    const lut = voiToLut(40, 400, "LINEAR", 257);
    expect(lut[0]).toBeCloseTo(0, 2);
    expect(lut[lut.length - 1]).toBeCloseTo(1, 2);
    expect(lut[(lut.length - 1) / 2]).toBeCloseTo(0.5, 2);
  });

  it("LINEAR : table monotone non décroissante", () => {
    const lut = voiToLut(40, 400, "LINEAR", 256);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it("SIGMOID : centre de la table ~0.5", () => {
    const lut = voiToLut(40, 400, "SIGMOID", 257);
    expect(lut[(lut.length - 1) / 2]).toBeCloseTo(0.5, 6);
  });

  it("SIGMOID : table strictement croissante", () => {
    const lut = voiToLut(40, 400, "SIGMOID", 256);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThan(lut[i - 1]);
    }
  });

  it("toutes les entrées sont dans [0,1]", () => {
    for (const fn of ["LINEAR", "SIGMOID"] as VoiLutFunction[]) {
      const lut = voiToLut(-200, 1500, fn, 512);
      for (const v of lut) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("les entrées de la LUT concordent avec l'application directe", () => {
    const wc = 40;
    const ww = 400;
    const n = 64;
    const lut = voiToLut(wc, ww, "LINEAR", n);
    const start = wc - ww / 2;
    for (let i = 0; i < n; i++) {
      const x = start + (i / (n - 1)) * ww;
      expect(lut[i]).toBeCloseTo(applyLinearVoi(x, wc, ww), 6);
    }
  });

  it("gère une fenêtre dégénérée (ww <= 0) sans NaN", () => {
    const lut = voiToLut(100, 0, "SIGMOID", 16);
    for (const v of lut) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
