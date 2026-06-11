import { describe, it, expect } from "vitest";
import {
  parseStudyDate,
  evaluatePredicate,
  evaluateGroup,
  type Predicate,
  type StudyLike,
  type PredicateGroup,
} from "./smartAlbumPredicate";

// Étude de référence réutilisée dans les tests nominaux.
const base: StudyLike = {
  patientName: "DUPONT^Jean",
  patientID: "PID-12345",
  modality: "CT",
  studyDate: "20240115",
  seriesCount: 5,
  accession: "ACC-001",
  institution: "Hôpital Cantonal de Genève",
};

describe("parseStudyDate", () => {
  it("parse le format DICOM YYYYMMDD", () => {
    expect(parseStudyDate("20240115")).toBe(20240115);
  });

  it("parse le format ISO avec séparateurs", () => {
    expect(parseStudyDate("2024-01-15")).toBe(20240115);
    expect(parseStudyDate("2024/01/15")).toBe(20240115);
    expect(parseStudyDate("2024.01.15")).toBe(20240115);
  });

  it("accepte un entier YYYYMMDD déjà numérique", () => {
    expect(parseStudyDate(20240115)).toBe(20240115);
  });

  it("rejette les dates hors borne calendaire", () => {
    expect(parseStudyDate("20241301")).toBeNull(); // mois 13
    expect(parseStudyDate("20240132")).toBeNull(); // jour 32
    expect(parseStudyDate("20240100")).toBeNull(); // jour 0
    expect(parseStudyDate("20240015")).toBeNull(); // mois 0
  });

  it("rejette les entrées vides / mal formées / nulles", () => {
    expect(parseStudyDate("")).toBeNull();
    expect(parseStudyDate("   ")).toBeNull();
    expect(parseStudyDate("2024011")).toBeNull(); // 7 chiffres
    expect(parseStudyDate("abcdefgh")).toBeNull();
    expect(parseStudyDate(null)).toBeNull();
    expect(parseStudyDate(undefined)).toBeNull();
    expect(parseStudyDate({})).toBeNull();
  });

  it("rejette un entier hors plage YYYYMMDD", () => {
    expect(parseStudyDate(123)).toBeNull();
    expect(parseStudyDate(20240115.5)).toBeNull(); // non entier
  });
});

describe("evaluatePredicate — champs texte", () => {
  it("contains insensible à la casse", () => {
    const p: Predicate = {
      field: "patientName",
      op: "contains",
      value: "dupont",
    };
    expect(evaluatePredicate(base, p)).toBe(true);
  });

  it("contains négatif", () => {
    const p: Predicate = {
      field: "patientName",
      op: "contains",
      value: "martin",
    };
    expect(evaluatePredicate(base, p)).toBe(false);
  });

  it("equals exact insensible à la casse", () => {
    const p: Predicate = {
      field: "patientID",
      op: "equals",
      value: "pid-12345",
    };
    expect(evaluatePredicate(base, p)).toBe(true);
  });

  it("equals refuse une correspondance partielle", () => {
    const p: Predicate = { field: "patientID", op: "equals", value: "pid" };
    expect(evaluatePredicate(base, p)).toBe(false);
  });

  it("institution contains", () => {
    const p: Predicate = {
      field: "institution",
      op: "contains",
      value: "genève",
    };
    expect(evaluatePredicate(base, p)).toBe(true);
  });

  it("accession equals", () => {
    const p: Predicate = { field: "accession", op: "equals", value: "ACC-001" };
    expect(evaluatePredicate(base, p)).toBe(true);
  });

  it("champ texte absent → false", () => {
    const study: StudyLike = { ...base, patientName: null };
    const p: Predicate = {
      field: "patientName",
      op: "contains",
      value: "dupont",
    };
    expect(evaluatePredicate(study, p)).toBe(false);
  });

  it("valeur de recherche vide → false", () => {
    const p: Predicate = { field: "patientName", op: "contains", value: "" };
    expect(evaluatePredicate(base, p)).toBe(false);
  });

  it("opérateur incompatible (gt sur texte) → false", () => {
    const p = {
      field: "patientName",
      op: "gt",
      value: "x",
    } as unknown as Predicate;
    expect(evaluatePredicate(base, p)).toBe(false);
  });
});

describe("evaluatePredicate — modalité multiple", () => {
  it("contains sur modalité combinée CT\\MR", () => {
    const study: StudyLike = { ...base, modality: "CT\\MR" };
    expect(
      evaluatePredicate(study, { field: "modality", op: "equals", value: "mr" })
    ).toBe(true);
    expect(
      evaluatePredicate(study, { field: "modality", op: "equals", value: "ct" })
    ).toBe(true);
  });

  it("equals sur modalité fournie en tableau", () => {
    const study: StudyLike = { ...base, modality: ["PT", "CT"] };
    expect(
      evaluatePredicate(study, { field: "modality", op: "equals", value: "PT" })
    ).toBe(true);
    expect(
      evaluatePredicate(study, { field: "modality", op: "equals", value: "us" })
    ).toBe(false);
  });

  it("modalité absente → false", () => {
    const study: StudyLike = { ...base, modality: null };
    expect(
      evaluatePredicate(study, { field: "modality", op: "equals", value: "CT" })
    ).toBe(false);
  });
});

describe("evaluatePredicate — studyDate", () => {
  it("before / after", () => {
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "before",
        value: "20240201",
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "after",
        value: "20240101",
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "before",
        value: "20240101",
      })
    ).toBe(false);
  });

  it("equals (bornes strictes : pas d'égalité pour before/after)", () => {
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "equals",
        value: "20240115",
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "before",
        value: "20240115",
      })
    ).toBe(false);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "after",
        value: "20240115",
      })
    ).toBe(false);
  });

  it("between inclusif et insensible à l'ordre des bornes", () => {
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: ["20240101", "20240131"],
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: ["20240131", "20240101"], // bornes inversées
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: ["20240115", "20240115"], // borne = date exacte
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: ["20240201", "20240228"],
      })
    ).toBe(false);
  });

  it("date d'étude absente / invalide → false", () => {
    expect(
      evaluatePredicate(
        { ...base, studyDate: null },
        {
          field: "studyDate",
          op: "before",
          value: "20240201",
        }
      )
    ).toBe(false);
    expect(
      evaluatePredicate(
        { ...base, studyDate: "garbage" },
        {
          field: "studyDate",
          op: "before",
          value: "20240201",
        }
      )
    ).toBe(false);
  });

  it("valeur de comparaison invalide → false", () => {
    expect(
      evaluatePredicate(base, { field: "studyDate", op: "before", value: "xx" })
    ).toBe(false);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: ["20240101", "bad"],
      })
    ).toBe(false);
    expect(
      evaluatePredicate(base, {
        field: "studyDate",
        op: "between",
        value: "20240101",
      })
    ).toBe(false); // between sans paire
  });

  it("opérateur incompatible (contains sur date) → false", () => {
    const p = {
      field: "studyDate",
      op: "contains",
      value: "2024",
    } as unknown as Predicate;
    expect(evaluatePredicate(base, p)).toBe(false);
  });
});

describe("evaluatePredicate — seriesCount", () => {
  it("equals / gt / lt", () => {
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "equals", value: 5 })
    ).toBe(true);
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "gt", value: 4 })
    ).toBe(true);
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "lt", value: 6 })
    ).toBe(true);
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "gt", value: 5 })
    ).toBe(false);
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "lt", value: 5 })
    ).toBe(false);
  });

  it("accepte une valeur numérique fournie en chaîne", () => {
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "gt", value: "4" })
    ).toBe(true);
  });

  it("between inclusif sur nombres", () => {
    expect(
      evaluatePredicate(base, {
        field: "seriesCount",
        op: "between",
        value: [1, 10],
      })
    ).toBe(true);
    expect(
      evaluatePredicate(base, {
        field: "seriesCount",
        op: "between",
        value: [10, 1],
      })
    ).toBe(true); // bornes inversées
    expect(
      evaluatePredicate(base, {
        field: "seriesCount",
        op: "between",
        value: [6, 10],
      })
    ).toBe(false);
  });

  it("seriesCount absent → false", () => {
    expect(
      evaluatePredicate(
        { ...base, seriesCount: null },
        {
          field: "seriesCount",
          op: "gt",
          value: 0,
        }
      )
    ).toBe(false);
  });

  it("seriesCount à zéro est une valeur valide (≠ absent)", () => {
    expect(
      evaluatePredicate(
        { ...base, seriesCount: 0 },
        {
          field: "seriesCount",
          op: "equals",
          value: 0,
        }
      )
    ).toBe(true);
    expect(
      evaluatePredicate(
        { ...base, seriesCount: 0 },
        {
          field: "seriesCount",
          op: "lt",
          value: 1,
        }
      )
    ).toBe(true);
  });

  it("valeur de comparaison non numérique → false", () => {
    expect(
      evaluatePredicate(base, { field: "seriesCount", op: "gt", value: "abc" })
    ).toBe(false);
  });

  it("opérateur incompatible (before sur nombre) → false", () => {
    const p = {
      field: "seriesCount",
      op: "before",
      value: 5,
    } as unknown as Predicate;
    expect(evaluatePredicate(base, p)).toBe(false);
  });
});

describe("evaluatePredicate — cas dégénérés", () => {
  it("étude null/undefined → false", () => {
    const p: Predicate = { field: "patientName", op: "contains", value: "x" };
    expect(evaluatePredicate(null, p)).toBe(false);
    expect(evaluatePredicate(undefined, p)).toBe(false);
  });

  it("prédicat null/undefined → false", () => {
    expect(evaluatePredicate(base, null)).toBe(false);
    expect(evaluatePredicate(base, undefined)).toBe(false);
  });

  it("champ inconnu → false", () => {
    const p = {
      field: "bogus",
      op: "equals",
      value: "x",
    } as unknown as Predicate;
    expect(evaluatePredicate(base, p)).toBe(false);
  });
});

describe("evaluateGroup", () => {
  const ctRecent: Predicate = { field: "modality", op: "equals", value: "CT" };
  const after2023: Predicate = {
    field: "studyDate",
    op: "after",
    value: "20230101",
  };
  const mrOnly: Predicate = { field: "modality", op: "equals", value: "MR" };

  it("AND : toutes les conditions doivent passer", () => {
    const g: PredicateGroup = {
      logic: "AND",
      predicates: [ctRecent, after2023],
    };
    expect(evaluateGroup(base, g)).toBe(true);
  });

  it("AND : une condition fausse → false", () => {
    const g: PredicateGroup = { logic: "AND", predicates: [ctRecent, mrOnly] };
    expect(evaluateGroup(base, g)).toBe(false);
  });

  it("OR : au moins une condition vraie", () => {
    const g: PredicateGroup = { logic: "OR", predicates: [mrOnly, ctRecent] };
    expect(evaluateGroup(base, g)).toBe(true);
  });

  it("OR : aucune condition vraie → false", () => {
    const g: PredicateGroup = { logic: "OR", predicates: [mrOnly] };
    expect(evaluateGroup(base, g)).toBe(false);
  });

  it("AND vide → true (aucune contrainte)", () => {
    expect(evaluateGroup(base, { logic: "AND", predicates: [] })).toBe(true);
  });

  it("OR vide → false (aucune condition satisfaite)", () => {
    expect(evaluateGroup(base, { logic: "OR", predicates: [] })).toBe(false);
  });

  it("groupe / étude null → false", () => {
    expect(evaluateGroup(base, null)).toBe(false);
    expect(evaluateGroup(null, { logic: "AND", predicates: [ctRecent] })).toBe(
      false
    );
  });

  it("logique inconnue → false", () => {
    const g = {
      logic: "XOR",
      predicates: [ctRecent],
    } as unknown as PredicateGroup;
    expect(evaluateGroup(base, g)).toBe(false);
  });

  it("predicates non tableau → false", () => {
    const g = { logic: "AND", predicates: null } as unknown as PredicateGroup;
    expect(evaluateGroup(base, g)).toBe(false);
  });
});
