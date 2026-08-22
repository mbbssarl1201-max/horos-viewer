import { describe, it, expect } from "vitest";
import {
  selectExhaustiveSeries,
  parseScreenReply,
} from "./exhaustivePreanalysis";

const S = [
  {
    id: 1,
    seriesDescription: "Scano   Scano   2.0 FL03",
    modality: "CT",
    numberOfInstances: 2,
    seriesNumber: 1,
  },
  {
    id: 2,
    seriesDescription: "Tissu Mou Standard Vol.   0.5 FC08",
    modality: "CT",
    numberOfInstances: 199,
    seriesNumber: 3,
  },
  {
    id: 3,
    seriesDescription: "OS Dur Vol.   0.5 FC30",
    modality: "CT",
    numberOfInstances: 32,
    seriesNumber: 4,
  },
  {
    id: 4,
    seriesDescription: "SUMMARY   2",
    modality: "CT",
    numberOfInstances: 2,
    seriesNumber: 99,
  },
];

describe("selectExhaustiveSeries — anti-scanogramme (analyse exhaustive)", () => {
  it("wholeStudy sans coupes (scano+SUMMARY seulement) → refuse", () => {
    const r = selectExhaustiveSeries({ wholeStudy: true }, [S[0], S[3]]);
    expect(r.refuse).toBe(true);
    expect(r.series).toEqual([]);
  });

  it("wholeStudy avec coupes → garde les séries diagnostiques, exclut scano/SUMMARY", () => {
    const r = selectExhaustiveSeries({ wholeStudy: true }, S);
    expect(r.refuse).toBe(false);
    expect(r.series.map(s => s.id).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("série unique = scano alors que des coupes existent → redirige vers la plus grosse série", () => {
    const r = selectExhaustiveSeries({ seriesId: 1 }, S);
    expect(r.refuse).toBe(false);
    expect(r.series).toHaveLength(1);
    expect(r.series[0].id).toBe(2);
  });

  it("série unique = vraie série de coupes → inchangée", () => {
    const r = selectExhaustiveSeries({ seriesId: 3 }, S);
    expect(r.refuse).toBe(false);
    expect(r.series[0].id).toBe(3);
  });
});

describe("parseScreenReply", () => {
  it("extrait et filtre les numéros autorisés", () => {
    expect(
      parseScreenReply("Coupes 142, 143 et 999 suspectes", [141, 142, 143])
    ).toEqual([142, 143]);
  });

  it("RAS → aucun", () => {
    expect(parseScreenReply("RAS", [1, 2, 3])).toEqual([]);
  });

  it("dédoublonne", () => {
    expect(parseScreenReply("7, 7, 7", [7])).toEqual([7]);
  });

  it("réponse vide → aucun", () => {
    expect(parseScreenReply("", [1, 2])).toEqual([]);
  });
});
