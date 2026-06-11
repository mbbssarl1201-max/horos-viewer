import { describe, it, expect } from "vitest";
import {
  parseDicomTimeToSeconds,
  decayTimeSeconds,
  computeSuvFactor,
  extractSuvMetadataFromDataset,
  type SuvMetadata,
  type DicomDatasetLike,
} from "./suv";

describe("parseDicomTimeToSeconds", () => {
  it("parse HHMMSS", () => {
    expect(parseDicomTimeToSeconds("093000")).toBe(9 * 3600 + 30 * 60);
  });
  it("parse HHMMSS.frac", () => {
    expect(parseDicomTimeToSeconds("093000.500")).toBeCloseTo(
      9 * 3600 + 30 * 60 + 0.5,
      6
    );
  });
  it("tolère les deux-points", () => {
    expect(parseDicomTimeToSeconds("09:30:00")).toBe(9 * 3600 + 30 * 60);
  });
  it("parse HH seul", () => {
    expect(parseDicomTimeToSeconds("09")).toBe(9 * 3600);
  });
  it("rejette les valeurs invalides", () => {
    expect(parseDicomTimeToSeconds("")).toBeNull();
    expect(parseDicomTimeToSeconds("abc")).toBeNull();
    expect(parseDicomTimeToSeconds("250000")).toBeNull(); // 25h
    expect(parseDicomTimeToSeconds(null)).toBeNull();
    expect(parseDicomTimeToSeconds(undefined)).toBeNull();
  });
});

describe("decayTimeSeconds", () => {
  it("calcule un Δt simple", () => {
    // injection 08:00:00, acquisition 09:00:00 → 3600 s
    expect(decayTimeSeconds("080000", "090000")).toBe(3600);
  });
  it("gère le passage de minuit", () => {
    // injection 23:30:00, acquisition 00:30:00 → 3600 s
    expect(decayTimeSeconds("233000", "003000")).toBe(3600);
  });
  it("rend null si une heure est invalide", () => {
    expect(decayTimeSeconds("xx", "090000")).toBeNull();
    expect(decayTimeSeconds("080000", null)).toBeNull();
  });
});

describe("computeSuvFactor", () => {
  // Cas de référence FDG (18F) : demi-vie ~6586,2 s (109,77 min).
  // Dose injectée 370 MBq = 3.7e8 Bq, poids 70 kg, Δt = 1 h (3600 s).
  // dose_décroissue = 3.7e8 * 2^(-3600/6586.2) = 3.7e8 * 0.6850... ≈ 2.5347e8 Bq
  // poids_g = 70000 g
  // factor = 70000 / 2.5347e8 ≈ 2.762e-4
  const base: SuvMetadata = {
    patientWeightKg: 70,
    radionuclideTotalDoseBq: 3.7e8,
    radionuclideHalfLifeSec: 6586.2,
    radiopharmaceuticalStartTime: "080000",
    seriesTime: "090000",
    units: "BQML",
  };

  it("calcule un facteur SUV connu (FDG)", () => {
    const res = computeSuvFactor(base);
    expect(res.factor).not.toBeNull();
    expect(res.reason).toBeNull();
    expect(res.decayTimeSec).toBe(3600);
    // dose décroissue attendue
    const expectedDecayed = 3.7e8 * Math.pow(2, -3600 / 6586.2);
    expect(res.decayedDoseBq).toBeCloseTo(expectedDecayed, 0);
    expect(res.factor!).toBeCloseTo(70000 / expectedDecayed, 10);
    // sanity : ordre de grandeur ~2.76e-4
    expect(res.factor!).toBeGreaterThan(2.5e-4);
    expect(res.factor!).toBeLessThan(3.0e-4);
  });

  it("sans décroissance (Δt = 0) : factor = poids_g / dose", () => {
    const res = computeSuvFactor({
      ...base,
      radiopharmaceuticalStartTime: "090000",
      seriesTime: "090000",
    });
    expect(res.decayTimeSec).toBe(0);
    expect(res.factor!).toBeCloseTo(70000 / 3.7e8, 12);
  });

  it("vérifie qu'un SUV ~1 correspond à une distribution uniforme", () => {
    // Si tout le traceur était réparti uniformément dans le corps (densité 1
    // g/mL), la concentration serait dose_décroissue / poids_mL.
    const res = computeSuvFactor(base);
    const decayed = res.decayedDoseBq!;
    const uniformConc = decayed / (70 * 1000); // Bq/mL (70 kg ≈ 70000 mL)
    const suv = uniformConc * res.factor!;
    expect(suv).toBeCloseTo(1, 6);
  });

  it("rend null si le poids manque", () => {
    const res = computeSuvFactor({ ...base, patientWeightKg: null });
    expect(res.factor).toBeNull();
    expect(res.reason).toMatch(/poids/i);
  });

  it("rend null si la dose manque", () => {
    const res = computeSuvFactor({ ...base, radionuclideTotalDoseBq: 0 });
    expect(res.factor).toBeNull();
    expect(res.reason).toMatch(/dose/i);
  });

  it("rend null si la demi-vie manque", () => {
    const res = computeSuvFactor({ ...base, radionuclideHalfLifeSec: "" });
    expect(res.factor).toBeNull();
    expect(res.reason).toMatch(/demi-vie/i);
  });

  it("rend null si les temps sont indisponibles", () => {
    const res = computeSuvFactor({ ...base, seriesTime: "bad" });
    expect(res.factor).toBeNull();
    expect(res.reason).toMatch(/temps/i);
  });

  it("avertit (non bloquant) si unités ≠ BQML", () => {
    const res = computeSuvFactor({ ...base, units: "CNTS" });
    expect(res.factor).not.toBeNull(); // calcul quand même
    expect(res.reason).toMatch(/BQML/);
  });

  it("accepte des chaînes DICOM pour les nombres", () => {
    const res = computeSuvFactor({
      ...base,
      patientWeightKg: "70",
      radionuclideTotalDoseBq: "370000000",
      radionuclideHalfLifeSec: "6586.2",
    });
    expect(res.factor).not.toBeNull();
  });
});

describe("extractSuvMetadataFromDataset", () => {
  // Faux dataset dicom-parser couvrant les tags + la séquence radiopharma.
  const fakeDs: DicomDatasetLike = {
    string(tag: string) {
      const map: Record<string, string> = {
        x00101030: "70",
        x00080031: "090000",
        x00541001: "BQML",
      };
      return map[tag];
    },
    floatString(tag: string) {
      const map: Record<string, number> = { x00101030: 70 };
      return map[tag];
    },
    elements: {
      x00540016: {
        items: [
          {
            dataSet: {
              string(tag: string) {
                const map: Record<string, string> = {
                  x00181074: "370000000",
                  x00181075: "6586.2",
                  x00181072: "080000",
                };
                return map[tag];
              },
              floatString(tag: string) {
                const map: Record<string, number> = {
                  x00181074: 3.7e8,
                  x00181075: 6586.2,
                };
                return map[tag];
              },
            },
          },
        ],
      },
    },
  };

  it("extrait les tags SUV puis calcule un facteur valide", () => {
    const meta = extractSuvMetadataFromDataset(fakeDs);
    expect(meta.patientWeightKg).toBe(70);
    expect(meta.seriesTime).toBe("090000");
    expect(meta.units).toBe("BQML");
    expect(meta.radionuclideTotalDoseBq).toBe(3.7e8);
    expect(meta.radionuclideHalfLifeSec).toBeCloseTo(6586.2, 3);
    expect(meta.radiopharmaceuticalStartTime).toBe("080000");
    const res = computeSuvFactor(meta);
    expect(res.factor).not.toBeNull();
  });

  it("dataset null/sans séquence → champs indéfinis, pas d'exception", () => {
    expect(extractSuvMetadataFromDataset(null)).toEqual({});
    const partial: DicomDatasetLike = {
      string: (t: string) => (t === "x00101030" ? "80" : undefined),
    };
    const meta = extractSuvMetadataFromDataset(partial);
    expect(meta.patientWeightKg).toBe(80);
    expect(meta.radionuclideTotalDoseBq).toBeUndefined();
    // calcul → null (dose manquante)
    expect(computeSuvFactor(meta).factor).toBeNull();
  });
});
