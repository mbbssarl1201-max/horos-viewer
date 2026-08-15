import { describe, it, expect } from "vitest";
import { regionsDe, filtrerParAnatomie } from "./anatomie";

describe("regionsDe", () => {
  it("détecte la région d'une demande SUVA", () => {
    expect(regionsDe("CT pied / chevilles")).toEqual(
      new Set(["cheville_pied"])
    );
    expect(regionsDe("CT articulation de l'épaule / bras")).toEqual(
      new Set(["epaule_bras"])
    );
    expect(regionsDe("Radiologie colonne vertébrale")).toEqual(
      new Set(["rachis"])
    );
  });

  it("détecte l'abdomen dans des libellés de séries", () => {
    expect(
      regionsDe("Abdo Std. Axial Natif 5.0 FC08 · Abdo Std. Volume")
    ).toEqual(new Set(["abdomen"]));
  });

  it("aucun indice anatomique ⇒ vide (séries techniques)", () => {
    expect(regionsDe("OS Hi Resolution 2.0 FC81 · Tissu Mou Standard")).toEqual(
      new Set()
    );
  });
});

describe("filtrerParAnatomie", () => {
  // Cas réel Syla : SUVA demande « CT pied / chevilles » ; 3 CT à ±7 jours dont
  // 2 abdomens et 1 ostéo sans mention de région.
  it("écarte les CT abdomen quand la demande est la cheville, garde l'ostéo neutre", () => {
    const retenus = filtrerParAnatomie("CT pied / chevilles", [
      {
        studyId: 673,
        libelles: "Scano · Abdo Std. Axial Natif · Abdo Std. Volume",
      },
      {
        studyId: 943,
        libelles: "Scano · OS Hi Resolution · Tissu Mou Standard",
      },
      {
        studyId: 1214,
        libelles: "Scano · Abdo Std. Volume Coronal CE Arteriel",
      },
    ]);
    expect(retenus).toEqual([943]);
  });

  it("préfère la correspondance explicite aux études neutres", () => {
    const retenus = filtrerParAnatomie("CT genou", [
      { studyId: 1, libelles: "OS Hi Resolution" },
      { studyId: 2, libelles: "Genou droit natif" },
    ]);
    expect(retenus).toEqual([2]);
  });

  it("demande sans indice anatomique ⇒ aucune restriction", () => {
    const retenus = filtrerParAnatomie("CT (sans description)", [
      { studyId: 1, libelles: "Abdo Std." },
      { studyId: 2, libelles: "Genou" },
    ]);
    expect(retenus).toEqual([1, 2]);
  });

  it("toutes les études contredisent la demande ⇒ aucune retenue", () => {
    const retenus = filtrerParAnatomie("CT cheville", [
      { studyId: 1, libelles: "Abdo Std." },
      { studyId: 2, libelles: "Thorax natif" },
    ]);
    expect(retenus).toEqual([]);
  });
});
