import { describe, it, expect } from "vitest";
import {
  normalizeText,
  tokenize,
  buildSearchMatcher,
  matchAllFields,
  filterByModality,
  parseDicomDate,
  filterByDateRange,
  type StudyRecord,
} from "./studySearch";

// Jeu d'études d'exemple (forme proche du navigateur Horos).
const studies: StudyRecord[] = [
  {
    patientName: "MÜLLER^Hans",
    patientId: "P001",
    studyDescription: "Scanner thoracique",
    modality: "CT",
    studyDate: "20240115",
    referringPhysician: "Dr Élise",
  },
  {
    patientName: "Dupont^Jean",
    patientId: "P002",
    studyDescription: "IRM cérébrale",
    modality: "MR",
    studyDate: "20231220",
    referringPhysician: "Dr Martin",
  },
  {
    patientName: "Smith^John",
    patientId: "P003",
    studyDescription: "PET-CT corps entier",
    modality: "CT\\PT",
    studyDate: "20240301",
    referringPhysician: "Dr Martin",
  },
];

const fields = [
  "patientName",
  "patientId",
  "studyDescription",
  "modality",
  "referringPhysician",
];

describe("normalizeText", () => {
  it("met en minuscules et retire les accents", () => {
    expect(normalizeText("MÜLLER")).toBe("muller");
    expect(normalizeText("Élise")).toBe("elise");
    expect(normalizeText("Écho Doppler")).toBe("echo doppler");
  });

  it("compacte les espaces et trim", () => {
    expect(normalizeText("  a   b  ")).toBe("a b");
  });

  it("gère null / undefined / nombres", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText(42)).toBe("42");
    expect(normalizeText("")).toBe("");
  });
});

describe("tokenize", () => {
  it("découpe en mots normalisés", () => {
    expect(tokenize("Müller Hans")).toEqual(["muller", "hans"]);
  });

  it("renvoie [] pour une requête vide ou blanche", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("buildSearchMatcher", () => {
  it("requête vide → tout passe", () => {
    const m = buildSearchMatcher("", fields);
    expect(studies.every(m)).toBe(true);
  });

  it("recherche insensible casse/accents", () => {
    const m = buildSearchMatcher("müller", fields);
    expect(m(studies[0])).toBe(true);
    expect(m(studies[1])).toBe(false);
    // « muller » sans accent et en minuscules trouve aussi.
    expect(buildSearchMatcher("MULLER", fields)(studies[0])).toBe(true);
  });

  it("ET sur les mots, OU sur les champs", () => {
    // « jean dupont » : les deux mots présents (champs name) → match.
    expect(buildSearchMatcher("jean dupont", fields)(studies[1])).toBe(true);
    // « dupont martin » : dupont (name) + martin (referent) → OU sur champs.
    expect(buildSearchMatcher("dupont martin", fields)(studies[1])).toBe(true);
    // « dupont smith » : smith absent de l'étude Dupont → pas de match.
    expect(buildSearchMatcher("dupont smith", fields)(studies[1])).toBe(false);
  });

  it("recherche par sous-chaîne (partielle)", () => {
    expect(buildSearchMatcher("thora", fields)(studies[0])).toBe(true);
    expect(buildSearchMatcher("P00", fields)(studies[0])).toBe(true);
  });

  it("recherche par modalité dans le texte", () => {
    expect(buildSearchMatcher("ct", fields)(studies[0])).toBe(true);
    expect(buildSearchMatcher("mr", fields)(studies[0])).toBe(false);
  });

  it("filtre une liste complète", () => {
    const m = buildSearchMatcher("martin", fields);
    expect(studies.filter(m)).toHaveLength(2);
  });

  it("dégénéré : étude null/undefined → false", () => {
    const m = buildSearchMatcher("x", fields);
    expect(m(null as unknown as StudyRecord)).toBe(false);
    expect(m(undefined as unknown as StudyRecord)).toBe(false);
  });

  it("dégénéré : champs vides → aucun match (sauf requête vide)", () => {
    expect(buildSearchMatcher("muller", [])(studies[0])).toBe(false);
    expect(buildSearchMatcher("", [])(studies[0])).toBe(true);
  });

  it("dégénéré : fields non-tableau toléré", () => {
    const m = buildSearchMatcher("x", null as unknown as string[]);
    expect(m(studies[0])).toBe(false);
  });

  it("champ absent de l'étude est ignoré sans erreur", () => {
    const m = buildSearchMatcher("muller", ["inconnu", "patientName"]);
    expect(m(studies[0])).toBe(true);
  });

  it("pas de collision entre champs adjacents", () => {
    // « 001scanner » ne doit PAS matcher (P001 + Scanner joints par espace).
    const m = buildSearchMatcher("001scanner", fields);
    expect(m(studies[0])).toBe(false);
  });
});

describe("matchAllFields", () => {
  it("cherche dans toutes les clés de l'objet", () => {
    expect(matchAllFields(studies[0], "muller")).toBe(true);
    expect(matchAllFields(studies[0], "thoracique")).toBe(true);
    expect(matchAllFields(studies[0], "20240115")).toBe(true);
    expect(matchAllFields(studies[0], "absent")).toBe(false);
  });

  it("requête vide → true", () => {
    expect(matchAllFields(studies[0], "")).toBe(true);
    expect(matchAllFields(studies[0], "   ")).toBe(true);
  });

  it("dégénéré : étude null → false (sauf requête vide via court-circuit)", () => {
    expect(matchAllFields(null as unknown as StudyRecord, "x")).toBe(false);
    // Requête vide est court-circuitée avant l'accès à l'étude.
    expect(matchAllFields(null as unknown as StudyRecord, "")).toBe(true);
  });

  it("objet vide → false pour requête non vide", () => {
    expect(matchAllFields({}, "x")).toBe(false);
  });
});

describe("filterByModality", () => {
  it("filtre exactement par modalité (normalisée)", () => {
    expect(filterByModality(studies, "CT")).toHaveLength(2); // CT + CT\PT
    expect(filterByModality(studies, "mr")).toHaveLength(1);
    expect(filterByModality(studies, "PT")).toHaveLength(1); // via CT\PT
  });

  it("gère les modalités multiples séparées (CT\\PT)", () => {
    const res = filterByModality(studies, "pt");
    expect(res).toHaveLength(1);
    expect(res[0].patientId).toBe("P003");
  });

  it("modalité vide → liste inchangée (copie)", () => {
    const res = filterByModality(studies, "");
    expect(res).toHaveLength(studies.length);
    expect(res).not.toBe(studies); // nouveau tableau
  });

  it("pas de correspondance partielle", () => {
    expect(filterByModality(studies, "C")).toHaveLength(0);
  });

  it("champ source surchargeable", () => {
    const custom: StudyRecord[] = [{ modalitiesInStudy: "US" }];
    expect(filterByModality(custom, "us", "modalitiesInStudy")).toHaveLength(1);
  });

  it("dégénéré : entrée non-tableau / éléments nuls", () => {
    expect(filterByModality(null as unknown as StudyRecord[], "ct")).toEqual(
      []
    );
    expect(filterByModality([null as unknown as StudyRecord], "ct")).toEqual(
      []
    );
    expect(filterByModality([{}], "ct")).toEqual([]);
  });

  it("ne modifie pas l'entrée", () => {
    const copy = studies.slice();
    filterByModality(studies, "ct");
    expect(studies).toEqual(copy);
  });
});

describe("parseDicomDate", () => {
  it("parse YYYYMMDD en entier comparable", () => {
    expect(parseDicomDate("20240115")).toBe(20240115);
  });

  it("tolère les séparateurs - / .", () => {
    expect(parseDicomDate("2024-01-15")).toBe(20240115);
    expect(parseDicomDate("2024/01/15")).toBe(20240115);
    expect(parseDicomDate("2024.01.15")).toBe(20240115);
  });

  it("rejette les formats invalides / bornes hors plage", () => {
    expect(parseDicomDate("2024011")).toBeNull();
    expect(parseDicomDate("abcd0101")).toBeNull();
    expect(parseDicomDate("20241301")).toBeNull(); // mois 13
    expect(parseDicomDate("20240132")).toBeNull(); // jour 32
    expect(parseDicomDate("20240100")).toBeNull(); // jour 0
    expect(parseDicomDate("")).toBeNull();
    expect(parseDicomDate(null)).toBeNull();
    expect(parseDicomDate(undefined)).toBeNull();
  });

  it("conserve l'ordre lexicographique en entier", () => {
    const a = parseDicomDate("20231220")!;
    const b = parseDicomDate("20240115")!;
    expect(a).toBeLessThan(b);
  });
});

describe("filterByDateRange", () => {
  it("plage inclusive [from, to]", () => {
    const res = filterByDateRange(studies, "20240101", "20240201");
    expect(res).toHaveLength(1);
    expect(res[0].patientId).toBe("P001");
  });

  it("borne basse seule (to absent)", () => {
    expect(filterByDateRange(studies, "20240101", null)).toHaveLength(2);
  });

  it("borne haute seule (from absent)", () => {
    expect(filterByDateRange(studies, "", "20240101")).toHaveLength(1);
  });

  it("aucune borne → liste inchangée (copie)", () => {
    const res = filterByDateRange(studies, null, null);
    expect(res).toHaveLength(studies.length);
    expect(res).not.toBe(studies);
  });

  it("bornes inclusives aux extrémités exactes", () => {
    expect(filterByDateRange(studies, "20240115", "20240115")).toHaveLength(1);
    expect(filterByDateRange(studies, "20231220", "20240301")).toHaveLength(3);
  });

  it("bornes inversées sont ré-ordonnées", () => {
    expect(filterByDateRange(studies, "20240201", "20240101")).toHaveLength(1);
  });

  it("étude sans date parsable est exclue quand un filtre est posé", () => {
    const withBad: StudyRecord[] = [
      ...studies,
      { patientId: "PX", studyDate: "??" },
    ];
    const res = filterByDateRange(withBad, "20231201", "20240401");
    expect(res.find(s => s.patientId === "PX")).toBeUndefined();
    expect(res).toHaveLength(3);
  });

  it("champ date surchargeable", () => {
    const custom: StudyRecord[] = [{ acqDate: "20240115" }];
    expect(
      filterByDateRange(custom, "20240101", "20240201", "acqDate")
    ).toHaveLength(1);
  });

  it("dégénéré : entrée non-tableau / éléments nuls", () => {
    expect(
      filterByDateRange(null as unknown as StudyRecord[], "20240101", null)
    ).toEqual([]);
    expect(
      filterByDateRange([null as unknown as StudyRecord], "20240101", null)
    ).toEqual([]);
  });

  it("ne modifie pas l'entrée", () => {
    const copy = studies.slice();
    filterByDateRange(studies, "20240101", "20240201");
    expect(studies).toEqual(copy);
  });
});
