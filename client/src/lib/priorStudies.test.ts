import { describe, it, expect } from "vitest";
import {
  type StudySummary,
  studyChronoKey,
  normalizeModality,
  findPriors,
  groupByModality,
  mostRecentPrior,
} from "./priorStudies";

/** Fabrique concise d'une étude pour les tests. */
function study(
  p: Partial<StudySummary> & { studyInstanceUid: string }
): StudySummary {
  return {
    patientId: "PAT-1",
    studyDate: undefined,
    studyTime: undefined,
    modality: undefined,
    studyDescription: undefined,
    ...p,
  };
}

describe("studyChronoKey", () => {
  it("encode date+heure dans l'ordre chronologique", () => {
    const k1 = studyChronoKey("20240101", "080000");
    const k2 = studyChronoKey("20240101", "090000");
    const k3 = studyChronoKey("20240102", "000000");
    expect(k1).not.toBeNull();
    expect(k2!).toBeGreaterThan(k1!);
    expect(k3!).toBeGreaterThan(k2!);
  });

  it("heure absente → 000000 (date prime)", () => {
    expect(studyChronoKey("20240101")).toBe(20240101 * 1_000_000);
  });

  it("tolère les séparateurs - / . et : dans date et heure", () => {
    expect(studyChronoKey("2024-01-02", "09:30:15")).toBe(
      studyChronoKey("20240102", "093015")
    );
  });

  it("tolère HH et HHMM partiels", () => {
    expect(studyChronoKey("20240101", "09")).toBe(20240101 * 1_000_000 + 90000);
    expect(studyChronoKey("20240101", "0930")).toBe(
      20240101 * 1_000_000 + 93000
    );
  });

  it("date absente / vide / non parsable → null", () => {
    expect(studyChronoKey(null)).toBeNull();
    expect(studyChronoKey(undefined)).toBeNull();
    expect(studyChronoKey("")).toBeNull();
    expect(studyChronoKey("2024")).toBeNull();
    expect(studyChronoKey("abcdefgh")).toBeNull();
    expect(studyChronoKey("202401")).toBeNull();
  });

  it("bornes mois/jour invalides → null", () => {
    expect(studyChronoKey("20241301")).toBeNull(); // mois 13
    expect(studyChronoKey("20240132")).toBeNull(); // jour 32
    expect(studyChronoKey("20240001")).toBeNull(); // mois 00
    expect(studyChronoKey("20240100")).toBeNull(); // jour 00
  });

  it("heure aberrante ignorée (000000), la date reste valide", () => {
    expect(studyChronoKey("20240101", "990000")).toBe(20240101 * 1_000_000);
    expect(studyChronoKey("20240101", "garbage")).toBe(20240101 * 1_000_000);
  });

  it("accepte les secondes bissextiles 60 (TM autorise 60)", () => {
    expect(studyChronoKey("20240101", "235960")).toBe(
      20240101 * 1_000_000 + 235960
    );
  });

  it("tolère une fraction de seconde", () => {
    expect(studyChronoKey("20240101", "093015.250")).toBe(
      20240101 * 1_000_000 + 93015
    );
  });
});

describe("normalizeModality", () => {
  it("trim + majuscules", () => {
    expect(normalizeModality(" ct ")).toBe("CT");
    expect(normalizeModality("mr")).toBe("MR");
  });
  it("null / undefined → chaîne vide", () => {
    expect(normalizeModality(null)).toBe("");
    expect(normalizeModality(undefined)).toBe("");
    expect(normalizeModality("   ")).toBe("");
  });
});

describe("findPriors", () => {
  const current = study({
    studyInstanceUid: "S-CUR",
    patientId: "PAT-1",
    studyDate: "20240601",
  });

  it("retourne les études du même patient, hors courante, par date décroissante", () => {
    const all: StudySummary[] = [
      current,
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
      study({
        studyInstanceUid: "S-B",
        patientId: "PAT-1",
        studyDate: "20240101",
      }),
      study({
        studyInstanceUid: "S-C",
        patientId: "PAT-1",
        studyDate: "20220101",
      }),
    ];
    const priors = findPriors(current, all);
    expect(priors.map(s => s.studyInstanceUid)).toEqual(["S-B", "S-A", "S-C"]);
  });

  it("exclut les études d'autres patients", () => {
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
      study({
        studyInstanceUid: "S-X",
        patientId: "PAT-2",
        studyDate: "20230101",
      }),
    ];
    const priors = findPriors(current, all);
    expect(priors.map(s => s.studyInstanceUid)).toEqual(["S-A"]);
  });

  it("exclut l'étude courante même si dupliquée dans la liste", () => {
    const dup = study({ studyInstanceUid: "S-CUR", patientId: "PAT-1" });
    const all: StudySummary[] = [
      current,
      dup,
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
    ];
    const priors = findPriors(current, all);
    expect(priors.map(s => s.studyInstanceUid)).toEqual(["S-A"]);
  });

  it("normalise le PatientID (trim) pour le rapprochement", () => {
    const cur = study({ studyInstanceUid: "S-CUR", patientId: " PAT-1 " });
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
    ];
    expect(findPriors(cur, all).map(s => s.studyInstanceUid)).toEqual(["S-A"]);
  });

  it("comparaison de PatientID sensible à la casse (identifiant technique)", () => {
    const cur = study({ studyInstanceUid: "S-CUR", patientId: "pat-1" });
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
    ];
    expect(findPriors(cur, all)).toEqual([]);
  });

  it("courante sans PatientID → aucune antériorité", () => {
    const cur = study({ studyInstanceUid: "S-CUR", patientId: null });
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-A",
        patientId: null,
        studyDate: "20230101",
      }),
      study({ studyInstanceUid: "S-B", patientId: "", studyDate: "20230101" }),
    ];
    expect(findPriors(cur, all)).toEqual([]);
  });

  it("liste vide / null / undefined → tableau vide", () => {
    expect(findPriors(current, [])).toEqual([]);
    expect(findPriors(current, null)).toEqual([]);
    expect(findPriors(current, undefined)).toEqual([]);
  });

  it("études non datées triées en dernier, départagées par UID", () => {
    const all: StudySummary[] = [
      study({ studyInstanceUid: "S-Z", patientId: "PAT-1" }),
      study({ studyInstanceUid: "S-A", patientId: "PAT-1" }),
      study({
        studyInstanceUid: "S-D",
        patientId: "PAT-1",
        studyDate: "20230101",
      }),
    ];
    const priors = findPriors(current, all);
    expect(priors.map(s => s.studyInstanceUid)).toEqual(["S-D", "S-A", "S-Z"]);
  });

  it("départage les dates identiques par heure puis par UID (déterministe)", () => {
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-B",
        patientId: "PAT-1",
        studyDate: "20230101",
        studyTime: "100000",
      }),
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20230101",
        studyTime: "100000",
      }),
      study({
        studyInstanceUid: "S-C",
        patientId: "PAT-1",
        studyDate: "20230101",
        studyTime: "120000",
      }),
    ];
    const priors = findPriors(current, all);
    // 12h d'abord, puis les deux 10h départagées par UID croissant (A avant B).
    expect(priors.map(s => s.studyInstanceUid)).toEqual(["S-C", "S-A", "S-B"]);
  });

  it("ne mute pas le tableau d'entrée", () => {
    const all: StudySummary[] = [
      study({
        studyInstanceUid: "S-A",
        patientId: "PAT-1",
        studyDate: "20220101",
      }),
      study({
        studyInstanceUid: "S-B",
        patientId: "PAT-1",
        studyDate: "20240101",
      }),
    ];
    const snapshot = all.map(s => s.studyInstanceUid);
    findPriors(current, all);
    expect(all.map(s => s.studyInstanceUid)).toEqual(snapshot);
  });
});

describe("groupByModality", () => {
  it("regroupe par modalité normalisée et préserve l'ordre interne", () => {
    const priors: StudySummary[] = [
      study({ studyInstanceUid: "S1", modality: "CT" }),
      study({ studyInstanceUid: "S2", modality: "mr" }),
      study({ studyInstanceUid: "S3", modality: " ct " }),
    ];
    const g = groupByModality(priors);
    expect([...g.keys()]).toEqual(["CT", "MR"]);
    expect(g.get("CT")!.map(s => s.studyInstanceUid)).toEqual(["S1", "S3"]);
    expect(g.get("MR")!.map(s => s.studyInstanceUid)).toEqual(["S2"]);
  });

  it("modalité absente → clé chaîne vide", () => {
    const priors: StudySummary[] = [
      study({ studyInstanceUid: "S1", modality: null }),
      study({ studyInstanceUid: "S2" }),
    ];
    const g = groupByModality(priors);
    expect(g.get("")!.map(s => s.studyInstanceUid)).toEqual(["S1", "S2"]);
  });

  it("liste vide / null → Map vide", () => {
    expect(groupByModality([]).size).toBe(0);
    expect(groupByModality(null).size).toBe(0);
    expect(groupByModality(undefined).size).toBe(0);
  });
});

describe("mostRecentPrior", () => {
  const current = study({
    studyInstanceUid: "S-CUR",
    patientId: "PAT-1",
    studyDate: "20240601",
  });
  const all: StudySummary[] = [
    current,
    study({
      studyInstanceUid: "S-CT-OLD",
      patientId: "PAT-1",
      studyDate: "20220101",
      modality: "CT",
    }),
    study({
      studyInstanceUid: "S-CT-NEW",
      patientId: "PAT-1",
      studyDate: "20240101",
      modality: "CT",
    }),
    study({
      studyInstanceUid: "S-MR",
      patientId: "PAT-1",
      studyDate: "20230601",
      modality: "MR",
    }),
  ];

  it("renvoie l'antériorité la plus récente toutes modalités confondues", () => {
    expect(mostRecentPrior(current, all)?.studyInstanceUid).toBe("S-CT-NEW");
  });

  it("filtre sur la modalité demandée (normalisée)", () => {
    expect(mostRecentPrior(current, all, "mr")?.studyInstanceUid).toBe("S-MR");
    expect(mostRecentPrior(current, all, "CT")?.studyInstanceUid).toBe(
      "S-CT-NEW"
    );
  });

  it("modalité vide → équivaut à toutes modalités", () => {
    expect(mostRecentPrior(current, all, "")?.studyInstanceUid).toBe(
      "S-CT-NEW"
    );
    expect(mostRecentPrior(current, all, "   ")?.studyInstanceUid).toBe(
      "S-CT-NEW"
    );
  });

  it("aucune antériorité de la modalité demandée → null", () => {
    expect(mostRecentPrior(current, all, "PT")).toBeNull();
  });

  it("aucune antériorité du tout → null", () => {
    const lonely = study({
      studyInstanceUid: "S-CUR",
      patientId: "PAT-9",
      studyDate: "20240601",
    });
    expect(mostRecentPrior(lonely, all)).toBeNull();
    expect(mostRecentPrior(current, [])).toBeNull();
    expect(mostRecentPrior(current, null)).toBeNull();
  });
});
