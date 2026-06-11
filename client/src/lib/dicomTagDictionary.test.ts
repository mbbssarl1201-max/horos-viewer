import { describe, it, expect } from "vitest";
import {
  TAG_DICTIONARY,
  normalizeTag,
  lookupTag,
  formatTagValue,
  searchTags,
  type ResolvedTag,
} from "./dicomTagDictionary";

describe("TAG_DICTIONARY", () => {
  it("contient au moins ~80 tags", () => {
    expect(Object.keys(TAG_DICTIONARY).length).toBeGreaterThanOrEqual(80);
  });

  it("expose des entrées clés bien formées", () => {
    expect(TAG_DICTIONARY["0010,0010"]).toEqual({
      keyword: "PatientName",
      name: "Patient's Name",
      vr: "PN",
    });
    expect(TAG_DICTIONARY["0020,000D"].keyword).toBe("StudyInstanceUID");
    expect(TAG_DICTIONARY["0008,0060"].vr).toBe("CS");
  });

  it("toutes les clés sont au format canonique GGGG,EEEE majuscule", () => {
    for (const key of Object.keys(TAG_DICTIONARY)) {
      expect(key).toMatch(/^[0-9A-F]{4},[0-9A-F]{4}$/);
    }
  });

  it("toutes les entrées ont keyword/name/vr non vides", () => {
    for (const info of Object.values(TAG_DICTIONARY)) {
      expect(info.keyword.length).toBeGreaterThan(0);
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.vr.length).toBeGreaterThan(0);
    }
  });

  it("aucun keyword dupliqué", () => {
    const keywords = Object.values(TAG_DICTIONARY).map(i => i.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it("est gelé (immuable)", () => {
    expect(Object.isFrozen(TAG_DICTIONARY)).toBe(true);
  });
});

describe("normalizeTag", () => {
  it("normalise la forme canonique", () => {
    expect(normalizeTag("0010,0010")).toBe("0010,0010");
  });
  it("accepte la forme compacte 8 chiffres", () => {
    expect(normalizeTag("00100010")).toBe("0010,0010");
  });
  it("accepte le préfixe x de dicom-parser", () => {
    expect(normalizeTag("x00100010")).toBe("0010,0010");
  });
  it("accepte les parenthèses", () => {
    expect(normalizeTag("(0010,0010)")).toBe("0010,0010");
  });
  it("accepte l'espace comme séparateur", () => {
    expect(normalizeTag("0010 0010")).toBe("0010,0010");
  });
  it("met en majuscule les hexa", () => {
    expect(normalizeTag("0020,000d")).toBe("0020,000D");
    expect(normalizeTag("x0020000d")).toBe("0020,000D");
  });
  it("complète les zéros de tête", () => {
    expect(normalizeTag("10,10")).toBe("0010,0010");
    expect(normalizeTag("8,60")).toBe("0008,0060");
  });
  it("tolère les espaces autour", () => {
    expect(normalizeTag("  0010,0010  ")).toBe("0010,0010");
  });
  it("rejette les valeurs vides / nulles", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag(undefined)).toBeNull();
  });
  it("rejette les non-hexa", () => {
    expect(normalizeTag("zzzz,0010")).toBeNull();
    expect(normalizeTag("0010,xyz")).toBeNull();
    expect(normalizeTag("hello")).toBeNull();
  });
  it("rejette les moitiés trop longues", () => {
    expect(normalizeTag("00010,0010")).toBeNull();
    expect(normalizeTag("0010,00010")).toBeNull();
  });
  it("rejette une forme compacte de mauvaise longueur", () => {
    expect(normalizeTag("001000")).toBeNull(); // 6 chiffres
    expect(normalizeTag("001000100")).toBeNull(); // 9 chiffres
  });
});

describe("lookupTag", () => {
  it("résout un tag connu (canonique)", () => {
    const r = lookupTag("0010,0010");
    expect(r).toEqual<ResolvedTag>({
      keyword: "PatientName",
      name: "Patient's Name",
      vr: "PN",
      group: "0010",
      element: "0010",
      tag: "0010,0010",
    });
  });
  it("résout via une forme alternative", () => {
    expect(lookupTag("x00100010")?.keyword).toBe("PatientName");
    expect(lookupTag("(0008,0060)")?.keyword).toBe("Modality");
    expect(lookupTag("20,000d")?.keyword).toBe("StudyInstanceUID");
  });
  it("renvoie null pour un tag inconnu", () => {
    expect(lookupTag("9999,9999")).toBeNull();
  });
  it("renvoie null pour une forme invalide", () => {
    expect(lookupTag("pas-un-tag")).toBeNull();
    expect(lookupTag(null)).toBeNull();
    expect(lookupTag("")).toBeNull();
  });
});

describe("formatTagValue — dégénérés", () => {
  it("null/undefined → chaîne vide", () => {
    expect(formatTagValue("PN", null)).toBe("");
    expect(formatTagValue("PN", undefined)).toBe("");
  });
  it("valeur vide / espaces → chaîne vide", () => {
    expect(formatTagValue("LO", "")).toBe("");
    expect(formatTagValue("LO", "   ")).toBe("");
  });
  it("VR inconnu → valeur trimée brute", () => {
    expect(formatTagValue("ZZ", "  abc  ")).toBe("abc");
    expect(formatTagValue(null, " x ")).toBe("x");
    expect(formatTagValue(undefined, "y")).toBe("y");
  });
  it("coerce une valeur non-chaîne", () => {
    expect(formatTagValue("IS", 42)).toBe("42");
    expect(formatTagValue("DS", 3.14)).toBe("3.14");
  });
});

describe("formatTagValue — DA (date)", () => {
  it("formate une date valide", () => {
    expect(formatTagValue("DA", "20240115")).toBe("2024-01-15");
  });
  it("gère le 29 février bissextile", () => {
    expect(formatTagValue("DA", "20240229")).toBe("2024-02-29");
  });
  it("rejette le 29 février non bissextile (rendu brut)", () => {
    expect(formatTagValue("DA", "20230229")).toBe("20230229");
  });
  it("rejette un mois/jour hors borne (rendu brut)", () => {
    expect(formatTagValue("DA", "20241301")).toBe("20241301");
    expect(formatTagValue("DA", "20240132")).toBe("20240132");
    expect(formatTagValue("DA", "20240400")).toBe("20240400"); // jour 0
  });
  it("rendu brut si format inattendu", () => {
    expect(formatTagValue("DA", "2024-01-15")).toBe("2024-01-15");
    expect(formatTagValue("da", "abc")).toBe("abc");
  });
  it("est insensible à la casse du VR", () => {
    expect(formatTagValue("da", "20240115")).toBe("2024-01-15");
  });
});

describe("formatTagValue — TM (heure)", () => {
  it("formate HHMMSS", () => {
    expect(formatTagValue("TM", "093015")).toBe("09:30:15");
  });
  it("formate HH seul (complété)", () => {
    expect(formatTagValue("TM", "09")).toBe("09:00:00");
  });
  it("formate HHMM", () => {
    expect(formatTagValue("TM", "0930")).toBe("09:30:00");
  });
  it("conserve la fraction de seconde", () => {
    expect(formatTagValue("TM", "093015.250")).toBe("09:30:15.250");
  });
  it("tolère la seconde 60 (saut)", () => {
    expect(formatTagValue("TM", "093060")).toBe("09:30:60");
  });
  it("rendu brut si heure hors borne", () => {
    expect(formatTagValue("TM", "250000")).toBe("250000");
    expect(formatTagValue("TM", "096100")).toBe("096100");
  });
});

describe("formatTagValue — PN (nom)", () => {
  it("formate Famille^Prénom", () => {
    expect(formatTagValue("PN", "Doe^John")).toBe("Doe, John");
  });
  it("joint plusieurs prénoms/composants", () => {
    expect(formatTagValue("PN", "Doe^John^Robert")).toBe("Doe, John Robert");
  });
  it("famille seule → famille", () => {
    expect(formatTagValue("PN", "Doe")).toBe("Doe");
    expect(formatTagValue("PN", "Doe^")).toBe("Doe");
  });
  it("ignore les composants vides", () => {
    expect(formatTagValue("PN", "Doe^^Robert")).toBe("Doe, Robert");
  });
  it("trim des composants", () => {
    expect(formatTagValue("PN", " Doe ^ John ")).toBe("Doe, John");
  });
});

describe("formatTagValue — AS (âge)", () => {
  it("formate les jours / semaines / mois / années", () => {
    expect(formatTagValue("AS", "045Y")).toBe("45 ans");
    expect(formatTagValue("AS", "001Y")).toBe("1 an");
    expect(formatTagValue("AS", "030D")).toBe("30 jours");
    expect(formatTagValue("AS", "001D")).toBe("1 jour");
    expect(formatTagValue("AS", "006W")).toBe("6 semaines");
    expect(formatTagValue("AS", "003M")).toBe("3 mois");
    expect(formatTagValue("AS", "001M")).toBe("1 mois");
  });
  it("tolère la minuscule de l'unité", () => {
    expect(formatTagValue("AS", "045y")).toBe("45 ans");
  });
  it("rendu brut si format inattendu", () => {
    expect(formatTagValue("AS", "45Y")).toBe("45Y"); // pas 3 chiffres
    expect(formatTagValue("AS", "045X")).toBe("045X"); // unité inconnue
  });
});

describe("formatTagValue — SQ et multi-valeurs", () => {
  it("SQ rendu comme séquence", () => {
    expect(formatTagValue("SQ", "anything")).toBe("<Séquence>");
  });
  it("formate chaque élément d'une multi-valeur DA", () => {
    expect(formatTagValue("DA", "20240115\\20240116")).toBe(
      "2024-01-15\\2024-01-16"
    );
  });
  it("formate chaque élément d'une multi-valeur PN", () => {
    expect(formatTagValue("PN", "Doe^John\\Roe^Jane")).toBe(
      "Doe, John\\Roe, Jane"
    );
  });
  it("VR numérique multi-valeur rendu brut", () => {
    expect(formatTagValue("DS", "1.0\\2.0\\3.0")).toBe("1.0\\2.0\\3.0");
  });
});

describe("searchTags", () => {
  it("trouve par mot-clé", () => {
    const r = searchTags("PatientName");
    expect(r.some(t => t.tag === "0010,0010")).toBe(true);
  });
  it("trouve par sous-chaîne du libellé (insensible à la casse)", () => {
    const r = searchTags("instance uid");
    const tags = r.map(t => t.tag);
    expect(tags).toContain("0020,000D"); // StudyInstanceUID
    expect(tags).toContain("0020,000E"); // SeriesInstanceUID
    expect(tags).toContain("0008,0018"); // SOPInstanceUID
  });
  it("trouve par clé canonique partielle", () => {
    const r = searchTags("0010,");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(t => t.group === "0010")).toBe(true);
  });
  it("trouve via une forme de tag alternative", () => {
    const r = searchTags("x00100010");
    expect(r.some(t => t.tag === "0010,0010")).toBe(true);
  });
  it("trouve par VR", () => {
    const r = searchTags("PN");
    expect(r.length).toBeGreaterThan(0);
    expect(r.some(t => t.vr === "PN")).toBe(true);
  });
  it("résultats triés par clé croissante", () => {
    const r = searchTags("uid");
    const tags = r.map(t => t.tag);
    const sorted = [...tags].sort();
    expect(tags).toEqual(sorted);
  });
  it("renvoie chaque résultat complet (ResolvedTag)", () => {
    const r = searchTags("Modality");
    expect(r[0]).toMatchObject({
      tag: "0008,0060",
      group: "0008",
      element: "0060",
      keyword: "Modality",
      vr: "CS",
    });
  });
  it("requête vide / nulle → liste vide", () => {
    expect(searchTags("")).toEqual([]);
    expect(searchTags("   ")).toEqual([]);
    expect(searchTags(null)).toEqual([]);
    expect(searchTags(undefined)).toEqual([]);
  });
  it("aucun résultat → liste vide", () => {
    expect(searchTags("zzz-introuvable-zzz")).toEqual([]);
  });
});
