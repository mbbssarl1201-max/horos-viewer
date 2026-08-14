import { describe, it, expect } from "vitest";
import {
  selectionnerEtudesARapatrier,
  SEUIL_ESPACE_LIBRE_OCTETS,
  LIMITE_ETUDES,
  type DemandeMinimale,
  type EtudeMinimale,
} from "./backfill";

const ESPACE_OK = SEUIL_ESPACE_LIBRE_OCTETS * 2;

function mapEtudes(...etudes: EtudeMinimale[]): Map<number, EtudeMinimale> {
  return new Map(etudes.map(e => [e.id, e]));
}

describe("selectionnerEtudesARapatrier", () => {
  it("retient une étude sans image réclamée par une demande a_valider", () => {
    const demandes: DemandeMinimale[] = [
      { statut: "a_valider", studyIds: [1] },
    ];
    const etudes = mapEtudes({
      id: 1,
      studyInstanceUid: "1.2.3",
      accessionNumber: "ACC-1",
      numberOfInstances: 0,
    });
    expect(selectionnerEtudesARapatrier(demandes, etudes, ESPACE_OK)).toEqual([
      { studyInstanceUid: "1.2.3", accessionNumber: "ACC-1" },
    ]);
  });

  it("ignore une étude qui a déjà des images", () => {
    const demandes: DemandeMinimale[] = [
      { statut: "a_valider", studyIds: [1] },
    ];
    const etudes = mapEtudes({
      id: 1,
      studyInstanceUid: "1.2.3",
      accessionNumber: null,
      numberOfInstances: 12,
    });
    expect(selectionnerEtudesARapatrier(demandes, etudes, ESPACE_OK)).toEqual(
      []
    );
  });

  it("ignore les demandes en statut terminal (envoyee, rejetee)", () => {
    const demandes: DemandeMinimale[] = [
      { statut: "envoyee", studyIds: [1] },
      { statut: "rejetee", studyIds: [2] },
    ];
    const etudes = mapEtudes(
      {
        id: 1,
        studyInstanceUid: "1.2.3",
        accessionNumber: null,
        numberOfInstances: 0,
      },
      {
        id: 2,
        studyInstanceUid: "4.5.6",
        accessionNumber: null,
        numberOfInstances: 0,
      }
    );
    expect(selectionnerEtudesARapatrier(demandes, etudes, ESPACE_OK)).toEqual(
      []
    );
  });

  it("dédoublonne une étude réclamée par plusieurs demandes", () => {
    const demandes: DemandeMinimale[] = [
      { statut: "a_valider", studyIds: [7] },
      { statut: "erreur", studyIds: [7] },
    ];
    const etudes = mapEtudes({
      id: 7,
      studyInstanceUid: "9.9",
      accessionNumber: null,
      numberOfInstances: 0,
    });
    expect(
      selectionnerEtudesARapatrier(demandes, etudes, ESPACE_OK)
    ).toHaveLength(1);
  });

  it("renvoie une liste vide si l'espace disque est sous le seuil", () => {
    const demandes: DemandeMinimale[] = [
      { statut: "a_valider", studyIds: [1] },
    ];
    const etudes = mapEtudes({
      id: 1,
      studyInstanceUid: "1.2.3",
      accessionNumber: null,
      numberOfInstances: 0,
    });
    expect(
      selectionnerEtudesARapatrier(
        demandes,
        etudes,
        SEUIL_ESPACE_LIBRE_OCTETS - 1
      )
    ).toEqual([]);
  });

  it("borne le nombre d'études renvoyées", () => {
    const demandes: DemandeMinimale[] = [
      {
        statut: "a_valider",
        studyIds: Array.from({ length: LIMITE_ETUDES + 10 }, (_, i) => i + 1),
      },
    ];
    const etudes = mapEtudes(
      ...Array.from({ length: LIMITE_ETUDES + 10 }, (_, i) => ({
        id: i + 1,
        studyInstanceUid: `uid-${i + 1}`,
        accessionNumber: null,
        numberOfInstances: 0,
      }))
    );
    expect(
      selectionnerEtudesARapatrier(demandes, etudes, ESPACE_OK)
    ).toHaveLength(LIMITE_ETUDES);
  });

  it("ignore une étude inconnue (fiche pas encore poussée)", () => {
    const demandes: DemandeMinimale[] = [{ statut: "prete", studyIds: [42] }];
    expect(
      selectionnerEtudesARapatrier(demandes, mapEtudes(), ESPACE_OK)
    ).toEqual([]);
  });
});
