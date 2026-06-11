import { describe, it, expect } from "vitest";
import {
  edgeLabelsFromIop,
  orientationStringForVector,
} from "./orientationLabels";

describe("orientationStringForVector", () => {
  it("renvoie une seule lettre pour un axe pur (LPS)", () => {
    expect(orientationStringForVector([1, 0, 0])).toBe("L"); // X+ → Left
    expect(orientationStringForVector([-1, 0, 0])).toBe("R"); // X- → Right
    expect(orientationStringForVector([0, 1, 0])).toBe("P"); // Y+ → Posterior
    expect(orientationStringForVector([0, -1, 0])).toBe("A"); // Y- → Anterior
    expect(orientationStringForVector([0, 0, 1])).toBe("H"); // Z+ → Head
    expect(orientationStringForVector([0, 0, -1])).toBe("F"); // Z- → Foot
  });

  it("compose les lettres par magnitude décroissante (oblique)", () => {
    // Y dominant (Anterior) puis X (Left) → « AL »
    expect(orientationStringForVector([0.3, -0.95, 0])).toBe("AL");
    // X dominant (Left) puis Y (Anterior) → « LA »
    expect(orientationStringForVector([0.95, -0.3, 0])).toBe("LA");
  });

  it("compose trois lettres pour un vecteur tri-oblique", () => {
    // |Z| > |Y| > |X| ; Z+ Head, Y- Anterior, X+ Left → « HAL »
    const s = orientationStringForVector([0.2, -0.5, 0.84]);
    expect(s).toBe("HAL");
  });

  it("ignore les composantes sous le seuil (bruit numérique)", () => {
    expect(orientationStringForVector([1, 0.00001, -0.00002])).toBe("L");
  });

  it("renvoie une chaîne vide pour le vecteur nul (dégénéré)", () => {
    expect(orientationStringForVector([0, 0, 0])).toBe("");
  });
});

describe("edgeLabelsFromIop — cas nominaux", () => {
  it("axial standard : top=A, bottom=P, left=R, right=L", () => {
    const labels = edgeLabelsFromIop([1, 0, 0, 0, 1, 0]);
    expect(labels).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });
  });

  it("sagittal standard : top=H, bottom=F, left=A, right=P", () => {
    // row = (0,1,0) → P à droite ; col = (0,0,-1) → F en bas, H en haut
    const labels = edgeLabelsFromIop([0, 1, 0, 0, 0, -1]);
    expect(labels).toEqual({ top: "H", bottom: "F", left: "A", right: "P" });
  });

  it("coronal standard : top=H, bottom=F, left=R, right=L", () => {
    // row = (1,0,0) → L à droite ; col = (0,0,-1) → F en bas, H en haut
    const labels = edgeLabelsFromIop([1, 0, 0, 0, 0, -1]);
    expect(labels).toEqual({ top: "H", bottom: "F", left: "R", right: "L" });
  });
});

describe("edgeLabelsFromIop — entrées DICOM en chaînes", () => {
  it("accepte des cosinus sous forme de chaînes (DS)", () => {
    const labels = edgeLabelsFromIop(["1", "0", "0", "0", "1", "0"]);
    expect(labels).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });
  });

  it("tolère les espaces autour des nombres", () => {
    const labels = edgeLabelsFromIop([" 1 ", "0", "0", "0", " 1 ", "0"]);
    expect(labels).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });
  });
});

describe("edgeLabelsFromIop — coupes obliques", () => {
  it("ligne oblique compose left/right correctement", () => {
    // row = (0.95, -0.3, 0) → right=« LA », left=« RP »
    const labels = edgeLabelsFromIop([0.95, -0.3, 0, 0, 0, -1]);
    expect(labels.right).toBe("LA");
    expect(labels.left).toBe("RP");
    expect(labels.top).toBe("H");
    expect(labels.bottom).toBe("F");
  });

  it("gauche est exactement l'opposé anatomique de droite (axial pivoté)", () => {
    const labels = edgeLabelsFromIop([0.7, 0.7, 0, -0.7, 0.7, 0]);
    // row=(0.7,0.7,0) magnitudes égales → ordre stable X puis Y : right=« LP »
    expect(labels.right).toBe("LP");
    expect(labels.left).toBe("RA");
    // col=(-0.7,0.7,0) → bottom : Y+ puis X- ... magnitudes égales, ordre X,Y
    expect(labels.bottom).toBe("RP");
    expect(labels.top).toBe("LA");
  });
});

describe("edgeLabelsFromIop — entrées invalides / dégénérées", () => {
  const EMPTY = { top: "", bottom: "", left: "", right: "" };

  it("renvoie des bords vides pour null/undefined", () => {
    expect(edgeLabelsFromIop(null)).toEqual(EMPTY);
    expect(edgeLabelsFromIop(undefined)).toEqual(EMPTY);
  });

  it("renvoie des bords vides si moins de 6 composantes", () => {
    expect(edgeLabelsFromIop([1, 0, 0, 0, 1])).toEqual(EMPTY);
    expect(edgeLabelsFromIop([])).toEqual(EMPTY);
  });

  it("renvoie des bords vides si une composante est non parsable", () => {
    expect(edgeLabelsFromIop([1, 0, 0, 0, "abc", 0])).toEqual(EMPTY);
    expect(edgeLabelsFromIop([1, 0, 0, 0, NaN, 0])).toEqual(EMPTY);
  });

  it("renvoie des bords vides si rowDir est nul", () => {
    expect(edgeLabelsFromIop([0, 0, 0, 0, 1, 0])).toEqual(EMPTY);
  });

  it("renvoie des bords vides si colDir est nul", () => {
    expect(edgeLabelsFromIop([1, 0, 0, 0, 0, 0])).toEqual(EMPTY);
  });

  it("ignore les composantes au-delà des 6 premières", () => {
    const labels = edgeLabelsFromIop([1, 0, 0, 0, 1, 0, 99, 99]);
    expect(labels).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });
  });
});

describe("edgeLabelsFromIop — cohérence des opposés", () => {
  it("top et bottom sont des directions opposées, left et right aussi", () => {
    const iop: (number | string)[] = [0.6, -0.5, 0.62, 0.1, 0.8, 0.59];
    const labels = edgeLabelsFromIop(iop);
    // Chaque bord doit produire une chaîne non vide ici (vecteurs non nuls).
    expect(labels.right.length).toBeGreaterThan(0);
    expect(labels.left.length).toBeGreaterThan(0);
    expect(labels.top.length).toBeGreaterThan(0);
    expect(labels.bottom.length).toBeGreaterThan(0);
    // L'opposé inverse chaque lettre (R<->L, A<->P, H<->F) dans le même ordre.
    const flip = (s: string): string =>
      s
        .split("")
        .map(c =>
          c === "R"
            ? "L"
            : c === "L"
              ? "R"
              : c === "A"
                ? "P"
                : c === "P"
                  ? "A"
                  : c === "H"
                    ? "F"
                    : "H"
        )
        .join("");
    expect(labels.left).toBe(flip(labels.right));
    expect(labels.top).toBe(flip(labels.bottom));
  });
});
