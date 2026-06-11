import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANNOTATION_LAYOUT,
  ALL_ANNOTATION_FIELDS,
  ALL_ANNOTATION_CORNERS,
  formatAnnotationField,
  renderCorner,
  renderAllCorners,
  type AnnotationLayout,
  type AnnotationContext,
} from "./customAnnotationsLayout";

const FULL_CTX: AnnotationContext = {
  columns: 512,
  rows: 512,
  windowCenter: 40,
  windowWidth: 400,
  zoom: 1.5,
  sliceIndex: 11,
  sliceCount: 240,
  patientName: "Doe^John",
  patientId: "PID-007",
  seriesDescription: "AX T1",
  studyDescription: "BRAIN MRI",
  date: "20240115",
  modality: "mr",
  institution: "Institut Champel",
};

describe("DEFAULT_ANNOTATION_LAYOUT", () => {
  it("définit les quatre coins avec des tableaux", () => {
    for (const corner of ALL_ANNOTATION_CORNERS) {
      expect(Array.isArray(DEFAULT_ANNOTATION_LAYOUT[corner])).toBe(true);
    }
  });

  it("place l'identité patient en haut-gauche", () => {
    expect(DEFAULT_ANNOTATION_LAYOUT.topLeft).toEqual([
      "patientName",
      "patientId",
    ]);
  });

  it("place fenêtrage et zoom en bas-gauche", () => {
    expect(DEFAULT_ANNOTATION_LAYOUT.bottomLeft).toContain("wlww");
    expect(DEFAULT_ANNOTATION_LAYOUT.bottomLeft).toContain("zoom");
  });
});

describe("ALL_ANNOTATION_FIELDS / CORNERS", () => {
  it("liste 11 champs distincts", () => {
    expect(new Set(ALL_ANNOTATION_FIELDS).size).toBe(11);
  });

  it("liste 4 coins distincts", () => {
    expect(ALL_ANNOTATION_CORNERS).toEqual([
      "topLeft",
      "topRight",
      "bottomLeft",
      "bottomRight",
    ]);
  });

  it("chaque champ par défaut est un champ connu", () => {
    for (const corner of ALL_ANNOTATION_CORNERS) {
      for (const f of DEFAULT_ANNOTATION_LAYOUT[corner]) {
        expect(ALL_ANNOTATION_FIELDS).toContain(f);
      }
    }
  });
});

describe("formatAnnotationField — imageSize", () => {
  it("formate les dimensions", () => {
    expect(formatAnnotationField("imageSize", FULL_CTX)).toBe("512 x 512");
  });
  it("arrondit les dimensions fractionnaires", () => {
    expect(
      formatAnnotationField("imageSize", { columns: 511.6, rows: 256.2 })
    ).toBe("512 x 256");
  });
  it("vide si une dimension manque", () => {
    expect(formatAnnotationField("imageSize", { columns: 512 })).toBe("");
    expect(formatAnnotationField("imageSize", {})).toBe("");
  });
  it("vide si dimension nulle ou négative", () => {
    expect(formatAnnotationField("imageSize", { columns: 0, rows: 512 })).toBe(
      ""
    );
    expect(formatAnnotationField("imageSize", { columns: -5, rows: 512 })).toBe(
      ""
    );
  });
  it("vide si NaN", () => {
    expect(
      formatAnnotationField("imageSize", { columns: NaN, rows: 512 })
    ).toBe("");
  });
});

describe("formatAnnotationField — wlww", () => {
  it("formate WL/WW arrondis", () => {
    expect(formatAnnotationField("wlww", FULL_CTX)).toBe("WL: 40 WW: 400");
  });
  it("arrondit les valeurs flottantes", () => {
    expect(
      formatAnnotationField("wlww", { windowCenter: 39.7, windowWidth: 400.4 })
    ).toBe("WL: 40 WW: 400");
  });
  it("accepte un centre négatif (ex. poumon)", () => {
    expect(
      formatAnnotationField("wlww", { windowCenter: -600, windowWidth: 1500 })
    ).toBe("WL: -600 WW: 1500");
  });
  it("vide si une valeur manque", () => {
    expect(formatAnnotationField("wlww", { windowCenter: 40 })).toBe("");
    expect(formatAnnotationField("wlww", {})).toBe("");
  });
});

describe("formatAnnotationField — zoom", () => {
  it("formate en pourcentage", () => {
    expect(formatAnnotationField("zoom", FULL_CTX)).toBe("Zoom: 150%");
  });
  it("100% pour zoom 1", () => {
    expect(formatAnnotationField("zoom", { zoom: 1 })).toBe("Zoom: 100%");
  });
  it("arrondit", () => {
    expect(formatAnnotationField("zoom", { zoom: 0.333 })).toBe("Zoom: 33%");
  });
  it("vide si zoom nul, négatif ou absent", () => {
    expect(formatAnnotationField("zoom", { zoom: 0 })).toBe("");
    expect(formatAnnotationField("zoom", { zoom: -2 })).toBe("");
    expect(formatAnnotationField("zoom", {})).toBe("");
  });
});

describe("formatAnnotationField — sliceInfo", () => {
  it("affiche en 1-based", () => {
    expect(formatAnnotationField("sliceInfo", FULL_CTX)).toBe("Im: 12/240");
  });
  it("première coupe", () => {
    expect(
      formatAnnotationField("sliceInfo", { sliceIndex: 0, sliceCount: 10 })
    ).toBe("Im: 1/10");
  });
  it("dernière coupe", () => {
    expect(
      formatAnnotationField("sliceInfo", { sliceIndex: 9, sliceCount: 10 })
    ).toBe("Im: 10/10");
  });
  it("vide si index hors borne", () => {
    expect(
      formatAnnotationField("sliceInfo", { sliceIndex: 10, sliceCount: 10 })
    ).toBe("");
    expect(
      formatAnnotationField("sliceInfo", { sliceIndex: -1, sliceCount: 10 })
    ).toBe("");
  });
  it("vide si total nul ou champs manquants", () => {
    expect(
      formatAnnotationField("sliceInfo", { sliceIndex: 0, sliceCount: 0 })
    ).toBe("");
    expect(formatAnnotationField("sliceInfo", { sliceIndex: 0 })).toBe("");
    expect(formatAnnotationField("sliceInfo", {})).toBe("");
  });
});

describe("formatAnnotationField — patientName", () => {
  it("remplace les « ^ » DICOM par des espaces", () => {
    expect(formatAnnotationField("patientName", FULL_CTX)).toBe("Doe John");
  });
  it("gère les composants vides et espaces multiples", () => {
    expect(
      formatAnnotationField("patientName", { patientName: "Doe^^John  Q" })
    ).toBe("Doe John Q");
  });
  it("trim les espaces de bord", () => {
    expect(
      formatAnnotationField("patientName", { patientName: "  Solo  " })
    ).toBe("Solo");
  });
  it("vide si absent ou chaîne vide", () => {
    expect(formatAnnotationField("patientName", {})).toBe("");
    expect(formatAnnotationField("patientName", { patientName: "" })).toBe("");
    expect(formatAnnotationField("patientName", { patientName: "   " })).toBe(
      ""
    );
    expect(formatAnnotationField("patientName", { patientName: null })).toBe(
      ""
    );
  });
});

describe("formatAnnotationField — patientId", () => {
  it("préfixe par « ID: »", () => {
    expect(formatAnnotationField("patientId", FULL_CTX)).toBe("ID: PID-007");
  });
  it("vide si absent", () => {
    expect(formatAnnotationField("patientId", {})).toBe("");
    expect(formatAnnotationField("patientId", { patientId: "  " })).toBe("");
  });
});

describe("formatAnnotationField — descriptions", () => {
  it("renvoie la description de série", () => {
    expect(formatAnnotationField("seriesDesc", FULL_CTX)).toBe("AX T1");
  });
  it("renvoie la description d'étude", () => {
    expect(formatAnnotationField("studyDesc", FULL_CTX)).toBe("BRAIN MRI");
  });
  it("trim", () => {
    expect(
      formatAnnotationField("seriesDesc", { seriesDescription: "  LOC  " })
    ).toBe("LOC");
  });
  it("vide si absent", () => {
    expect(formatAnnotationField("seriesDesc", {})).toBe("");
    expect(formatAnnotationField("studyDesc", {})).toBe("");
  });
});

describe("formatAnnotationField — date", () => {
  it("formate une date DICOM YYYYMMDD", () => {
    expect(formatAnnotationField("date", FULL_CTX)).toBe("2024-01-15");
  });
  it("laisse une date déjà formatée telle quelle", () => {
    expect(formatAnnotationField("date", { date: "2024-01-15" })).toBe(
      "2024-01-15"
    );
  });
  it("laisse une forme inconnue telle quelle (trim)", () => {
    expect(formatAnnotationField("date", { date: " 15 Jan 2024 " })).toBe(
      "15 Jan 2024"
    );
  });
  it("vide si absent", () => {
    expect(formatAnnotationField("date", {})).toBe("");
  });
});

describe("formatAnnotationField — modality / institution", () => {
  it("met la modalité en majuscules", () => {
    expect(formatAnnotationField("modality", FULL_CTX)).toBe("MR");
    expect(formatAnnotationField("modality", { modality: "ct" })).toBe("CT");
  });
  it("renvoie l'établissement tel quel (trim)", () => {
    expect(formatAnnotationField("institution", FULL_CTX)).toBe(
      "Institut Champel"
    );
  });
  it("vide si absent", () => {
    expect(formatAnnotationField("modality", {})).toBe("");
    expect(formatAnnotationField("institution", {})).toBe("");
  });
});

describe("renderCorner", () => {
  it("rend toutes les lignes d'un coin avec contexte complet", () => {
    expect(
      renderCorner(DEFAULT_ANNOTATION_LAYOUT, "topLeft", FULL_CTX)
    ).toEqual(["Doe John", "ID: PID-007"]);
  });

  it("préserve l'ordre des champs configurés", () => {
    expect(
      renderCorner(DEFAULT_ANNOTATION_LAYOUT, "topRight", FULL_CTX)
    ).toEqual(["BRAIN MRI", "AX T1", "MR", "2024-01-15"]);
  });

  it("filtre les champs sans donnée (pas de ligne vide)", () => {
    const ctx: AnnotationContext = { patientName: "Doe^John" }; // pas d'ID
    expect(renderCorner(DEFAULT_ANNOTATION_LAYOUT, "topLeft", ctx)).toEqual([
      "Doe John",
    ]);
  });

  it("renvoie [] si contexte totalement vide", () => {
    expect(renderCorner(DEFAULT_ANNOTATION_LAYOUT, "topRight", {})).toEqual([]);
  });

  it("renvoie [] pour un coin vide", () => {
    const layout: AnnotationLayout = {
      topLeft: [],
      topRight: [],
      bottomLeft: [],
      bottomRight: [],
    };
    expect(renderCorner(layout, "topLeft", FULL_CTX)).toEqual([]);
  });

  it("ne mute pas le layout d'entrée", () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_ANNOTATION_LAYOUT));
    renderCorner(DEFAULT_ANNOTATION_LAYOUT, "bottomLeft", FULL_CTX);
    expect(DEFAULT_ANNOTATION_LAYOUT).toEqual(before);
  });

  it("renvoie [] si le coin n'est pas un tableau (layout dégénéré)", () => {
    const bad = {
      topLeft: undefined,
    } as unknown as AnnotationLayout;
    expect(renderCorner(bad, "topLeft", FULL_CTX)).toEqual([]);
  });

  it("gère un layout null sans lever", () => {
    const nullLayout = null as unknown as AnnotationLayout;
    expect(renderCorner(nullLayout, "topLeft", FULL_CTX)).toEqual([]);
  });

  it("gère un champ répété et un champ rendu vide entre deux remplis", () => {
    const layout: AnnotationLayout = {
      topLeft: ["zoom", "patientId", "zoom"],
      topRight: [],
      bottomLeft: [],
      bottomRight: [],
    };
    const ctx: AnnotationContext = { zoom: 2 }; // patientId manquant → sauté
    expect(renderCorner(layout, "topLeft", ctx)).toEqual([
      "Zoom: 200%",
      "Zoom: 200%",
    ]);
  });
});

describe("renderAllCorners", () => {
  it("rend les quatre coins avec contexte complet", () => {
    const all = renderAllCorners(DEFAULT_ANNOTATION_LAYOUT, FULL_CTX);
    expect(all.topLeft).toEqual(["Doe John", "ID: PID-007"]);
    expect(all.bottomLeft).toEqual(["WL: 40 WW: 400", "Zoom: 150%"]);
    expect(all.bottomRight).toEqual(["512 x 512", "Im: 12/240"]);
    expect(all.topRight).toEqual(["BRAIN MRI", "AX T1", "MR", "2024-01-15"]);
  });

  it("renvoie quatre listes vides pour un contexte vide", () => {
    const all = renderAllCorners(DEFAULT_ANNOTATION_LAYOUT, {});
    expect(all.topLeft).toEqual([]);
    expect(all.topRight).toEqual([]);
    expect(all.bottomLeft).toEqual([]);
    expect(all.bottomRight).toEqual([]);
  });

  it("expose exactement les quatre clés de coin", () => {
    const all = renderAllCorners(DEFAULT_ANNOTATION_LAYOUT, FULL_CTX);
    expect(Object.keys(all).sort()).toEqual(
      ["bottomLeft", "bottomRight", "topLeft", "topRight"].sort()
    );
  });
});
