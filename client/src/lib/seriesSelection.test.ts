import { describe, it, expect } from "vitest";
import { shouldReselectSeries, pickDefaultSeries } from "./seriesSelection";

describe("shouldReselectSeries", () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("re-sélectionne quand rien n'est sélectionné et la liste est non vide", () => {
    expect(shouldReselectSeries(null, list)).toBe(true);
    expect(shouldReselectSeries(undefined, list)).toBe(true);
  });

  it("ne re-sélectionne pas quand la série sélectionnée appartient à la liste", () => {
    expect(shouldReselectSeries(2, list)).toBe(false);
  });

  it("re-sélectionne quand la série sélectionnée n'appartient pas à la liste (changement d'étude)", () => {
    expect(shouldReselectSeries(99, list)).toBe(true);
  });

  it("ne re-sélectionne pas quand la liste est vide ou nulle", () => {
    expect(shouldReselectSeries(null, [])).toBe(false);
    expect(shouldReselectSeries(2, [])).toBe(false);
    expect(shouldReselectSeries(null, null)).toBe(false);
    expect(shouldReselectSeries(2, undefined)).toBe(false);
  });
});

describe("pickDefaultSeries", () => {
  it("choisit la série DIAGNOSTIQUE la plus grosse, pas le scanogramme (cas étude réelle)", () => {
    // Reproduit l'étude 64 (DAUTI) : 2 scano + 3 séries de coupes + 1 SUMMARY.
    const list = [
      { id: 185, seriesDescription: "Scano   Scano   2.0 FL03", modality: "CT", numberOfInstances: 2 },
      { id: 186, seriesDescription: "Scano   Scano   2.0 FL03", modality: "CT", numberOfInstances: 2 },
      { id: 188, seriesDescription: "OS Dur Vol.   0.5 FC30", modality: "CT", numberOfInstances: 567 },
      { id: 189, seriesDescription: "Tissu Mou Standard Vol.", modality: "CT", numberOfInstances: 567 },
      { id: 190, seriesDescription: "Abdo Std. Volume Vol.  Natif", modality: "CT", numberOfInstances: 496 },
      { id: 187, seriesDescription: "SUMMARY  Natif 4", modality: "CT", numberOfInstances: 2 },
    ];
    // Doit choisir une des grosses séries (567), JAMAIS un scano/summary (id 185/186/187).
    const chosen = pickDefaultSeries(list);
    expect([188, 189]).toContain(chosen);
    expect([185, 186, 187]).not.toContain(chosen);
  });

  it("repli sur la 1re série si AUCUNE n'est diagnostique", () => {
    const onlyTech = [
      { id: 1, seriesDescription: "Scano", modality: "CT", numberOfInstances: 2 },
      { id: 2, seriesDescription: "Dose Report", modality: "SR", numberOfInstances: 1 },
    ];
    expect(pickDefaultSeries(onlyTech)).toBe(1);
  });

  it("liste vide / nulle → null", () => {
    expect(pickDefaultSeries([])).toBe(null);
    expect(pickDefaultSeries(null)).toBe(null);
    expect(pickDefaultSeries(undefined)).toBe(null);
  });

  it("série unique → la renvoie même sans métadonnées", () => {
    expect(pickDefaultSeries([{ id: 42 }])).toBe(42);
  });
});
