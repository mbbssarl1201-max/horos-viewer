import { describe, expect, it } from "vitest";
import { nextSort, sortStudies, type SortableStudy } from "./homeSort";

const ROWS: SortableStudy[] = [
  { id: 3, patientName: "Bernard", modality: "CT", studyDate: "20260101" },
  { id: 1, patientName: "alice", modality: "MR", studyDate: "20260103" },
  { id: 2, patientName: "Alice", modality: "CT", studyDate: "20260102" },
];

describe("sortStudies", () => {
  it("null = ordre d'entrée inchangé", () => {
    expect(sortStudies(ROWS, null, "asc").map(r => r.id)).toEqual([3, 1, 2]);
  });

  it("tri par nom insensible à la casse, asc", () => {
    // alice (1) et Alice (2) égaux → départagés par id ; Bernard (3) après.
    expect(sortStudies(ROWS, "patientName", "asc").map(r => r.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("desc inverse l'ordre, égalités incluses", () => {
    expect(sortStudies(ROWS, "patientName", "desc").map(r => r.id)).toEqual([
      3, 2, 1,
    ]);
  });

  it("tri numérique par id", () => {
    expect(sortStudies(ROWS, "id", "asc").map(r => r.id)).toEqual([1, 2, 3]);
  });

  it("tri par date d'examen", () => {
    expect(sortStudies(ROWS, "studyDate", "asc").map(r => r.id)).toEqual([
      3, 2, 1,
    ]);
  });

  it("ne mute pas le tableau source", () => {
    const copy = [...ROWS];
    sortStudies(ROWS, "id", "desc");
    expect(ROWS).toEqual(copy);
  });
});

describe("nextSort — cycle asc → desc → naturel", () => {
  it("nouvelle colonne → asc", () => {
    expect(nextSort({ key: null, dir: "asc" }, "modality")).toEqual({
      key: "modality",
      dir: "asc",
    });
  });
  it("même colonne asc → desc", () => {
    expect(nextSort({ key: "modality", dir: "asc" }, "modality")).toEqual({
      key: "modality",
      dir: "desc",
    });
  });
  it("même colonne desc → naturel (null)", () => {
    expect(nextSort({ key: "modality", dir: "desc" }, "modality")).toEqual({
      key: null,
      dir: "asc",
    });
  });
  it("changer de colonne repart en asc", () => {
    expect(nextSort({ key: "modality", dir: "desc" }, "id")).toEqual({
      key: "id",
      dir: "asc",
    });
  });
});
