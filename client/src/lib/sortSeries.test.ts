import { describe, it, expect } from "vitest";
import {
  sortByInstanceNumber,
  sortBySliceLocation,
  SORT_MODES,
  type SortableInstance,
} from "./sortSeries";

/** Petit helper : projette une propriété pour comparer les ordres. */
function pluck<K extends keyof SortableInstance>(
  arr: SortableInstance[],
  k: K
): Array<SortableInstance[K]> {
  return arr.map(x => x[k]);
}

describe("SORT_MODES", () => {
  it("expose les deux modes attendus avec id + label", () => {
    expect(SORT_MODES).toEqual([
      { id: "instanceNumber", label: "Numéro d'instance" },
      { id: "sliceLocation", label: "Position de coupe" },
    ]);
  });

  it("chaque mode a un id et un label non vides", () => {
    for (const m of SORT_MODES) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
});

describe("sortByInstanceNumber", () => {
  it("trie en ordre croissant par défaut", () => {
    const input = [
      { instanceNumber: 3 },
      { instanceNumber: 1 },
      { instanceNumber: 2 },
    ];
    expect(pluck(sortByInstanceNumber(input), "instanceNumber")).toEqual([
      1, 2, 3,
    ]);
  });

  it("trie en ordre décroissant quand asc = false", () => {
    const input = [
      { instanceNumber: 1 },
      { instanceNumber: 3 },
      { instanceNumber: 2 },
    ];
    expect(pluck(sortByInstanceNumber(input, false), "instanceNumber")).toEqual(
      [3, 2, 1]
    );
  });

  it("parse les numéros sous forme de chaîne DICOM", () => {
    const input = [
      { instanceNumber: "10" },
      { instanceNumber: "2" },
      { instanceNumber: " 1 " },
    ];
    expect(pluck(sortByInstanceNumber(input), "instanceNumber")).toEqual([
      " 1 ",
      "2",
      "10",
    ]);
  });

  it("ne mute pas le tableau d'entrée", () => {
    const input = [{ instanceNumber: 2 }, { instanceNumber: 1 }];
    const copy = [...input];
    sortByInstanceNumber(input);
    expect(input).toEqual(copy);
  });

  it("renvoie un NOUVEAU tableau (référence différente)", () => {
    const input = [{ instanceNumber: 1 }];
    expect(sortByInstanceNumber(input)).not.toBe(input);
  });

  it("est STABLE pour des valeurs égales (préserve l'ordre d'entrée)", () => {
    const input = [
      { instanceNumber: 1, tag: "a" },
      { instanceNumber: 1, tag: "b" },
      { instanceNumber: 1, tag: "c" },
    ];
    const out = sortByInstanceNumber(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual(["a", "b", "c"]);
  });

  it("garde l'ordre des égalités même en décroissant", () => {
    const input = [
      { instanceNumber: 2, tag: "a" },
      { instanceNumber: 2, tag: "b" },
      { instanceNumber: 1, tag: "c" },
    ];
    const out = sortByInstanceNumber(input, false);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual(["a", "b", "c"]);
  });

  it("repousse les instances sans numéro en fin de liste (croissant)", () => {
    const input = [
      { instanceNumber: null, tag: "x" },
      { instanceNumber: 2, tag: "b" },
      { instanceNumber: undefined, tag: "y" },
      { instanceNumber: 1, tag: "a" },
    ];
    const out = sortByInstanceNumber(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual([
      "a",
      "b",
      "x",
      "y",
    ]);
  });

  it("repousse les valeurs absentes en fin MÊME en décroissant", () => {
    const input = [
      { instanceNumber: undefined, tag: "x" },
      { instanceNumber: 1, tag: "a" },
      { instanceNumber: 3, tag: "c" },
      { instanceNumber: null, tag: "y" },
    ];
    const out = sortByInstanceNumber(input, false);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual([
      "c",
      "a",
      "x",
      "y",
    ]);
  });

  it("traite les chaînes non numériques comme absentes (en fin)", () => {
    const input = [
      { instanceNumber: "abc", tag: "x" },
      { instanceNumber: "", tag: "y" },
      { instanceNumber: 5, tag: "a" },
    ];
    const out = sortByInstanceNumber(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual(["a", "x", "y"]);
  });

  it("rejette NaN / Infinity (considérés absents)", () => {
    const input = [
      { instanceNumber: NaN, tag: "x" },
      { instanceNumber: Infinity, tag: "y" },
      { instanceNumber: 0, tag: "a" },
    ];
    const out = sortByInstanceNumber(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual(["a", "x", "y"]);
  });

  it("gère les numéros négatifs et zéro", () => {
    const input = [
      { instanceNumber: 0 },
      { instanceNumber: -5 },
      { instanceNumber: 3 },
    ];
    expect(pluck(sortByInstanceNumber(input), "instanceNumber")).toEqual([
      -5, 0, 3,
    ]);
  });

  it("liste vide → tableau vide", () => {
    expect(sortByInstanceNumber([])).toEqual([]);
  });

  it("null / undefined → tableau vide", () => {
    expect(sortByInstanceNumber(null)).toEqual([]);
    expect(sortByInstanceNumber(undefined)).toEqual([]);
  });

  it("un seul élément → renvoyé tel quel", () => {
    const input = [{ instanceNumber: 42 }];
    expect(pluck(sortByInstanceNumber(input), "instanceNumber")).toEqual([42]);
  });
});

describe("sortBySliceLocation", () => {
  it("trie en ordre croissant par défaut (valeurs décimales)", () => {
    const input = [
      { sliceLocation: 2.5 },
      { sliceLocation: -1.0 },
      { sliceLocation: 0.0 },
    ];
    expect(pluck(sortBySliceLocation(input), "sliceLocation")).toEqual([
      -1.0, 0.0, 2.5,
    ]);
  });

  it("trie en décroissant quand asc = false", () => {
    const input = [
      { sliceLocation: -1.0 },
      { sliceLocation: 2.5 },
      { sliceLocation: 0.0 },
    ];
    expect(pluck(sortBySliceLocation(input, false), "sliceLocation")).toEqual([
      2.5, 0.0, -1.0,
    ]);
  });

  it("parse les positions sous forme de chaîne DICOM", () => {
    const input = [
      { sliceLocation: "12.50" },
      { sliceLocation: "-3.0" },
      { sliceLocation: "0" },
    ];
    expect(pluck(sortBySliceLocation(input), "sliceLocation")).toEqual([
      "-3.0",
      "0",
      "12.50",
    ]);
  });

  it("est STABLE pour des positions égales", () => {
    const input = [
      { sliceLocation: 1.0, tag: "a" },
      { sliceLocation: 1.0, tag: "b" },
      { sliceLocation: 0.0, tag: "c" },
    ];
    const out = sortBySliceLocation(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual(["c", "a", "b"]);
  });

  it("repousse les positions absentes en fin de liste", () => {
    const input = [
      { sliceLocation: undefined, tag: "x" },
      { sliceLocation: 5.0, tag: "b" },
      { sliceLocation: 1.0, tag: "a" },
      { sliceLocation: null, tag: "y" },
    ];
    const out = sortBySliceLocation(input);
    expect(out.map(x => (x as { tag: string }).tag)).toEqual([
      "a",
      "b",
      "x",
      "y",
    ]);
  });

  it("liste vide / null / undefined → tableau vide", () => {
    expect(sortBySliceLocation([])).toEqual([]);
    expect(sortBySliceLocation(null)).toEqual([]);
    expect(sortBySliceLocation(undefined)).toEqual([]);
  });

  it("ne mute pas l'entrée et renvoie un nouveau tableau", () => {
    const input = [{ sliceLocation: 2 }, { sliceLocation: 1 }];
    const copy = [...input];
    const out = sortBySliceLocation(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  it("trie indépendamment du champ instanceNumber présent", () => {
    const input = [
      { instanceNumber: 1, sliceLocation: 9 },
      { instanceNumber: 2, sliceLocation: 3 },
      { instanceNumber: 3, sliceLocation: 6 },
    ];
    expect(pluck(sortBySliceLocation(input), "sliceLocation")).toEqual([
      3, 6, 9,
    ]);
  });
});
