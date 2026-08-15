import { describe, it, expect } from "vitest";
import { selectionnerCrDocs, type DocCuramed } from "./curamedCr";

function doc(partiel: Partial<DocCuramed>): DocCuramed {
  return {
    nom: "Syla",
    prenom: "Remzi",
    ddn: "19851030",
    titre: "",
    date: "",
    type: "Rapport",
    reference: "ref",
    ...partiel,
  };
}

describe("selectionnerCrDocs", () => {
  // Cas réel Syla : la SUVA demande « CT pied / chevilles du 08.12.2025 ».
  it("retient le CR « Scanner cheville et pied gauches du 08.12.25 » en tête", () => {
    const docs = [
      doc({
        titre: "Scanner cheville et pied gauches du 08.12.25",
        date: "20251209",
        type: "Général",
        reference: "bon",
      }),
      doc({ titre: "RapportAnalyses-33", date: "20250901", reference: "labo" }),
      doc({ titre: "mr Syla Remzi Echo", date: "20250910", reference: "echo" }),
      doc({ titre: "SCAN0147085", date: "20251030", reference: "scan-adm" }),
    ];
    const r = selectionnerCrDocs(
      docs,
      ["20251208", "20251203"],
      "CT pied / chevilles"
    );
    expect(r[0]?.reference).toBe("bon");
    // Les documents administratifs/labo éloignés ne passent pas le seuil.
    expect(r.map(x => x.reference)).not.toContain("labo");
  });

  it("écarte un CR d'une AUTRE région même à date proche", () => {
    const docs = [
      doc({
        titre: "IRM epaule droite du 05.12.25",
        date: "20251206",
        reference: "epaule",
      }),
    ];
    const r = selectionnerCrDocs(docs, ["20251208"], "CT pied / chevilles");
    expect(r).toEqual([]);
  });

  it("sans indice anatomique dans la demande : la proximité de date + imagerie suffisent", () => {
    const docs = [
      doc({
        titre: "Scanner du 12.01.26",
        date: "20260113",
        type: "Radiologie",
        reference: "ok",
      }),
    ];
    const r = selectionnerCrDocs(docs, ["20260112"], "CT (sans description)");
    expect(r[0]?.reference).toBe("ok");
  });

  it("aucun document au-dessus du seuil ⇒ rien (jamais un mauvais CR)", () => {
    const docs = [
      doc({
        titre: "Courrier assurance",
        date: "20240101",
        reference: "vieux",
      }),
    ];
    expect(selectionnerCrDocs(docs, ["20251208"], "CT cheville")).toEqual([]);
  });
});
