import { describe, it, expect } from "vitest";
import { clampPriorSlice, pickPriorSeries } from "./compareSync";

describe("clampPriorSlice", () => {
  it("laisse passer un indice valide", () => {
    expect(clampPriorSlice(5, 10)).toBe(5);
  });
  it("borne à la dernière coupe quand l'antériorité est plus courte", () => {
    expect(clampPriorSlice(50, 10)).toBe(9);
  });
  it("borne à 0 les indices négatifs", () => {
    expect(clampPriorSlice(-3, 10)).toBe(0);
  });
  it("renvoie 0 quand l'antériorité est vide ou dégénérée", () => {
    expect(clampPriorSlice(4, 0)).toBe(0);
    expect(clampPriorSlice(4, -2)).toBe(0);
    expect(clampPriorSlice(NaN, 10)).toBe(0);
    expect(clampPriorSlice(2.7, 10)).toBe(2);
  });
});

describe("pickPriorSeries", () => {
  const series = [
    { id: 11, modality: "SC" },
    { id: 12, modality: "CT" },
    { id: 13, modality: "CT" },
  ];
  it("préfère la première série de même modalité que la courante", () => {
    expect(pickPriorSeries(series, "CT")).toBe(12);
  });
  it("est insensible à la casse/espaces sur la modalité", () => {
    expect(pickPriorSeries(series, " ct ")).toBe(12);
  });
  it("replie sur la première série quand aucune ne matche", () => {
    expect(pickPriorSeries(series, "MR")).toBe(11);
  });
  it("replie sur la première série sans modalité courante", () => {
    expect(pickPriorSeries(series, null)).toBe(11);
    expect(pickPriorSeries(series, undefined)).toBe(11);
  });
  it("renvoie null sur liste vide ou absente", () => {
    expect(pickPriorSeries([], "CT")).toBe(null);
    expect(pickPriorSeries(null as any, "CT")).toBe(null);
  });
});
