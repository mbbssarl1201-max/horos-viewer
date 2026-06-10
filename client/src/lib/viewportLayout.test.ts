import { describe, it, expect } from "vitest";
import {
  VIEWPORT_LAYOUTS,
  DEFAULT_VIEWPORT_LAYOUT,
  layoutCellCount,
  layoutGridClass,
  clampActiveCell,
} from "./viewportLayout";

describe("layoutCellCount", () => {
  it("retourne 1 cellule pour 1x1", () => {
    expect(layoutCellCount("1x1")).toBe(1);
  });
  it("retourne 2 cellules pour 1x2", () => {
    expect(layoutCellCount("1x2")).toBe(2);
  });
  it("retourne 4 cellules pour 2x2", () => {
    expect(layoutCellCount("2x2")).toBe(4);
  });
});

describe("layoutGridClass", () => {
  it("une seule colonne/ligne en 1x1", () => {
    expect(layoutGridClass("1x1")).toContain("grid-cols-1");
    expect(layoutGridClass("1x1")).toContain("grid-rows-1");
  });
  it("deux colonnes en 1x2", () => {
    expect(layoutGridClass("1x2")).toContain("grid-cols-2");
    expect(layoutGridClass("1x2")).toContain("grid-rows-1");
  });
  it("grille 2x2", () => {
    expect(layoutGridClass("2x2")).toContain("grid-cols-2");
    expect(layoutGridClass("2x2")).toContain("grid-rows-2");
  });
  it("commence toujours par grid", () => {
    for (const l of VIEWPORT_LAYOUTS) {
      expect(layoutGridClass(l).startsWith("grid")).toBe(true);
    }
  });
});

describe("clampActiveCell", () => {
  it("garde l'index valide", () => {
    expect(clampActiveCell(0, "2x2")).toBe(0);
    expect(clampActiveCell(3, "2x2")).toBe(3);
  });
  it("borne l'index quand la disposition rétrécit", () => {
    expect(clampActiveCell(3, "1x1")).toBe(0);
    expect(clampActiveCell(3, "1x2")).toBe(1);
  });
  it("gère les entrées dégénérées", () => {
    expect(clampActiveCell(-1, "2x2")).toBe(0);
    expect(clampActiveCell(NaN, "2x2")).toBe(0);
    expect(clampActiveCell(1.7, "2x2")).toBe(1);
  });
});

describe("constantes de disposition", () => {
  it("la disposition par défaut est 1x1", () => {
    expect(DEFAULT_VIEWPORT_LAYOUT).toBe("1x1");
  });
  it("expose les trois dispositions", () => {
    expect(VIEWPORT_LAYOUTS).toEqual(["1x1", "1x2", "2x2"]);
  });
});
