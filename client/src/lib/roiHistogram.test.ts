import { describe, it, expect } from "vitest";
import { computeHistogram, histogramStats } from "./roiHistogram";

describe("computeHistogram — nominal", () => {
  it("répartit des valeurs simples sur la plage déduite", () => {
    const r = computeHistogram([0, 1, 2, 3], 4);
    expect(r.min).toBe(0);
    expect(r.max).toBe(3);
    expect(r.count).toBe(4);
    expect(r.bins).toHaveLength(4);
    expect(r.binEdges).toHaveLength(5);
    // chaque valeur dans son propre bin (3 ferme à droite)
    expect(r.bins).toEqual([1, 1, 1, 1]);
  });

  it("génère des binEdges linéaires et croissants", () => {
    const r = computeHistogram([0, 10], 5);
    expect(r.binEdges).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("la borne max tombe dans le DERNIER bin (fermé à droite)", () => {
    const r = computeHistogram([0, 100], 10);
    // 100 doit être compté dans le dernier bin, pas ignoré
    expect(r.count).toBe(2);
    expect(r.bins[0]).toBe(1);
    expect(r.bins[9]).toBe(1);
  });

  it("respecte min/max explicites et ignore le hors-plage", () => {
    const r = computeHistogram([-5, 0, 5, 10, 15], 2, 0, 10);
    expect(r.min).toBe(0);
    expect(r.max).toBe(10);
    // -5 et 15 ignorés → 0,5,10 comptés
    expect(r.count).toBe(3);
    // bins: [0,5[ et [5,10]
    expect(r.bins).toEqual([1, 2]); // 0 dans bin0 ; 5 et 10 dans bin1
  });

  it("comptage cohérent avec la somme des bins", () => {
    const vals = [1, 2, 2, 3, 3, 3, 4, 4, 4, 4];
    const r = computeHistogram(vals, 8);
    const total = r.bins.reduce((a, b) => a + b, 0);
    expect(total).toBe(r.count);
    expect(r.count).toBe(vals.length);
  });

  it("utilise 256 bins par défaut", () => {
    const r = computeHistogram([0, 1, 2, 3]);
    expect(r.bins).toHaveLength(256);
    expect(r.binEdges).toHaveLength(257);
  });
});

describe("computeHistogram — bords et dégénérés", () => {
  it("tableau vide → bins à zéro, count 0", () => {
    const r = computeHistogram([], 4);
    expect(r.count).toBe(0);
    expect(r.bins).toEqual([0, 0, 0, 0]);
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.binEdges).toEqual([0, 0, 0, 0, 0]);
  });

  it("vide mais avec min/max fournis → edges sur la plage", () => {
    const r = computeHistogram([], 2, 10, 20);
    expect(r.count).toBe(0);
    expect(r.min).toBe(10);
    expect(r.max).toBe(20);
    expect(r.binEdges).toEqual([10, 15, 20]);
    expect(r.bins).toEqual([0, 0]);
  });

  it("plage dégénérée (toutes valeurs égales) → tout dans un bin", () => {
    const r = computeHistogram([7, 7, 7], 4);
    expect(r.min).toBe(7);
    expect(r.max).toBe(7);
    expect(r.count).toBe(3);
    expect(r.bins[0]).toBe(3);
    expect(r.bins.slice(1)).toEqual([0, 0, 0]);
  });

  it("plage dégénérée via min===max explicite", () => {
    const r = computeHistogram([5, 5], 3, 5, 5);
    expect(r.count).toBe(2);
    expect(r.bins[0]).toBe(2);
  });

  it("écarte les valeurs non finies (NaN / Infinity)", () => {
    const r = computeHistogram([1, NaN, 2, Infinity, -Infinity, 3], 3);
    expect(r.min).toBe(1);
    expect(r.max).toBe(3);
    expect(r.count).toBe(3);
  });

  it("binCount < 1 ramené à 1", () => {
    const r = computeHistogram([1, 2, 3], 0);
    expect(r.bins).toHaveLength(1);
    expect(r.bins[0]).toBe(3);
  });

  it("binCount non entier tronqué", () => {
    const r = computeHistogram([0, 10], 4.9);
    expect(r.bins).toHaveLength(4);
  });

  it("binCount non fini ramené à 1", () => {
    const r = computeHistogram([1, 2, 3], NaN);
    expect(r.bins).toHaveLength(1);
  });

  it("bornes inversées (min > max) échangées", () => {
    const r = computeHistogram([2, 5, 8], 3, 10, 0);
    expect(r.min).toBe(0);
    expect(r.max).toBe(10);
    expect(r.count).toBe(3);
  });

  it("uniquement des valeurs non finies → résultat neutre", () => {
    const r = computeHistogram([NaN, Infinity], 4);
    expect(r.count).toBe(0);
    expect(r.min).toBe(0);
    expect(r.max).toBe(0);
    expect(r.bins).toEqual([0, 0, 0, 0]);
  });

  it("gère des valeurs négatives (Hounsfield)", () => {
    const r = computeHistogram([-1000, -500, 0, 500], 4, -1000, 500);
    expect(r.min).toBe(-1000);
    expect(r.max).toBe(500);
    expect(r.count).toBe(4);
    const total = r.bins.reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
  });

  it("edges extrêmes exactement égaux à lo/hi (pas de dérive)", () => {
    const r = computeHistogram([0, 1], 3, 0, 1);
    expect(r.binEdges[0]).toBe(0);
    expect(r.binEdges[r.binEdges.length - 1]).toBe(1);
  });
});

describe("histogramStats — nominal", () => {
  it("moyenne, min, max, médiane sur effectif impair", () => {
    const s = histogramStats([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.median).toBe(3);
  });

  it("médiane interpolée sur effectif pair", () => {
    const s = histogramStats([1, 2, 3, 4]);
    expect(s.median).toBe(2.5);
    expect(s.mean).toBe(2.5);
  });

  it("écart-type de population (diviseur N)", () => {
    // [2,4,4,4,5,5,7,9] : mean 5, variance pop 4, std 2
    const s = histogramStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.std).toBeCloseTo(2, 10);
  });

  it("ne mute pas le tableau d'entrée (tri médiane)", () => {
    const input = [3, 1, 2];
    histogramStats(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("histogramStats — bords et dégénérés", () => {
  it("tableau vide → tout à zéro", () => {
    expect(histogramStats([])).toEqual({
      mean: 0,
      std: 0,
      min: 0,
      max: 0,
      median: 0,
    });
  });

  it("valeur unique → std 0, médiane = la valeur", () => {
    const s = histogramStats([42]);
    expect(s.mean).toBe(42);
    expect(s.std).toBe(0);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.median).toBe(42);
  });

  it("valeurs identiques → std 0", () => {
    const s = histogramStats([7, 7, 7, 7]);
    expect(s.std).toBe(0);
    expect(s.median).toBe(7);
  });

  it("écarte NaN / Infinity", () => {
    const s = histogramStats([1, NaN, 3, Infinity, -Infinity]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.mean).toBe(2);
    expect(s.median).toBe(2);
  });

  it("uniquement non finies → neutre", () => {
    expect(histogramStats([NaN, Infinity])).toEqual({
      mean: 0,
      std: 0,
      min: 0,
      max: 0,
      median: 0,
    });
  });

  it("valeurs négatives", () => {
    const s = histogramStats([-3, -1, -1, -3]);
    expect(s.mean).toBe(-2);
    expect(s.min).toBe(-3);
    expect(s.max).toBe(-1);
    expect(s.median).toBe(-2);
  });
});
