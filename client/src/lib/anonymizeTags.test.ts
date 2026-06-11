import { describe, it, expect } from "vitest";
import {
  ANONYMIZATION_RULES,
  DEFAULT_PSEUDONYM,
  normalizeTagKey,
  isPrivateTag,
  buildRuleTable,
  applyAnonymizationPlan,
  type AnonymizationRule,
} from "./anonymizeTags";

describe("normalizeTagKey", () => {
  it("accepte la forme dicom-parser xggggeeee", () => {
    expect(normalizeTagKey("x00100010")).toBe("x00100010");
  });

  it("accepte 8 hex sans préfixe", () => {
    expect(normalizeTagKey("00100010")).toBe("x00100010");
  });

  it("accepte (gggg,eeee) et gggg,eeee", () => {
    expect(normalizeTagKey("(0010,0010)")).toBe("x00100010");
    expect(normalizeTagKey("0010,0010")).toBe("x00100010");
  });

  it("met en minuscules et tolère espaces", () => {
    expect(normalizeTagKey("0020 000D")).toBe("x0020000d");
  });

  it("renvoie null sur une clé invalide", () => {
    expect(normalizeTagKey("zzz")).toBeNull();
    expect(normalizeTagKey("0010001")).toBeNull(); // 7 hex
    expect(normalizeTagKey("001000100")).toBeNull(); // 9 hex
    expect(normalizeTagKey("")).toBeNull();
  });
});

describe("isPrivateTag", () => {
  it("vrai pour un groupe impair", () => {
    expect(isPrivateTag("x00090010")).toBe(true);
    expect(isPrivateTag("0041,0001")).toBe(true);
  });

  it("faux pour un groupe pair", () => {
    expect(isPrivateTag("x00100010")).toBe(false);
    expect(isPrivateTag("x00080020")).toBe(false);
  });

  it("faux sur un tag invalide", () => {
    expect(isPrivateTag("nope")).toBe(false);
  });
});

describe("ANONYMIZATION_RULES", () => {
  it("couvre les attributs PHI clés exigés par la spec", () => {
    const byTag = new Map(ANONYMIZATION_RULES.map(r => [r.tag, r]));
    for (const tag of [
      "x00100010", // PatientName
      "x00100020", // PatientID
      "x00100030", // PatientBirthDate
      "x00080080", // InstitutionName
      "x00080090", // ReferringPhysicianName
      "x0020000d", // StudyInstanceUID
      "x0020000e", // SeriesInstanceUID
      "x00080018", // SOPInstanceUID
      "x00080020", // StudyDate
    ]) {
      expect(byTag.has(tag)).toBe(true);
    }
  });

  it("toute règle replace fournit un replacement (string)", () => {
    for (const r of ANONYMIZATION_RULES) {
      if (r.action === "replace") {
        expect(typeof r.replacement).toBe("string");
      }
    }
  });

  it("PatientName/PatientID utilisent le pseudonyme par défaut", () => {
    const byTag = new Map(ANONYMIZATION_RULES.map(r => [r.tag, r]));
    expect(byTag.get("x00100010")?.replacement).toBe(DEFAULT_PSEUDONYM);
    expect(byTag.get("x00100020")?.replacement).toBe(DEFAULT_PSEUDONYM);
  });

  it("ne contient pas de doublons de tag", () => {
    const seen = new Set<string>();
    for (const r of ANONYMIZATION_RULES) {
      expect(seen.has(r.tag)).toBe(false);
      seen.add(r.tag);
    }
  });
});

describe("buildRuleTable", () => {
  it("injecte le pseudonyme personnalisé dans PatientName/ID", () => {
    const table = buildRuleTable({ pseudonym: "PSEUDO-42" });
    expect(table.get("x00100010")?.replacement).toBe("PSEUDO-42");
    expect(table.get("x00100020")?.replacement).toBe("PSEUDO-42");
  });

  it("ne touche pas le remplacement vide des UIDs", () => {
    const table = buildRuleTable({ pseudonym: "PSEUDO-42" });
    expect(table.get("x0020000d")?.replacement).toBe("");
  });

  it("keepDates transforme les dates en keep", () => {
    const table = buildRuleTable({ keepDates: true });
    expect(table.get("x00100030")?.action).toBe("keep"); // PatientBirthDate
    expect(table.get("x00080020")?.action).toBe("keep"); // StudyDate
  });

  it("extraRules surcharge une règle de base", () => {
    const extra: AnonymizationRule = {
      tag: "0010,0040",
      name: "PatientSex",
      action: "remove",
    };
    const table = buildRuleTable({ extraRules: [extra] });
    const rule = table.get("x00100040");
    expect(rule?.action).toBe("remove");
    expect(rule?.tag).toBe("x00100040"); // normalisé
  });

  it("ignore une extraRule au tag invalide", () => {
    const table = buildRuleTable({
      extraRules: [{ tag: "bad", name: "X", action: "remove" }],
    });
    // La table garde sa taille de base (aucune entrée ajoutée).
    expect(table.size).toBe(ANONYMIZATION_RULES.length);
  });
});

describe("applyAnonymizationPlan — nominal", () => {
  it("remplace l'identité, vide les dates, retire l'institution", () => {
    const out = applyAnonymizationPlan({
      x00100010: "DUPONT^Jean",
      x00100020: "PAT-007",
      x00100030: "19800101",
      x00080080: "Clinique Genève",
      x00080090: "Dr House",
    });
    expect(out.x00100010).toBe(DEFAULT_PSEUDONYM);
    expect(out.x00100020).toBe(DEFAULT_PSEUDONYM);
    expect(out.x00100030).toBe(""); // blank
    expect("x00080080" in out).toBe(false); // remove
    expect(out.x00080090).toBe(""); // ReferringPhysician blank
  });

  it("vide les UIDs sensibles (replace par chaîne vide)", () => {
    const out = applyAnonymizationPlan({
      x0020000d: "1.2.840.1",
      x0020000e: "1.2.840.2",
      x00080018: "1.2.840.3",
    });
    expect(out.x0020000d).toBe("");
    expect(out.x0020000e).toBe("");
    expect(out.x00080018).toBe("");
  });

  it("conserve les tags keep (sexe, description)", () => {
    const out = applyAnonymizationPlan({
      x00100040: "M",
      x00081030: "Thorax",
      x00080016: "1.2.840.10008.5.1.4.1.1.2",
    });
    expect(out.x00100040).toBe("M");
    expect(out.x00081030).toBe("Thorax");
    expect(out.x00080016).toBe("1.2.840.10008.5.1.4.1.1.2");
  });

  it("conserve un tag inconnu (non couvert, non privé)", () => {
    const out = applyAnonymizationPlan({ x00280010: "512" }); // Rows
    expect(out.x00280010).toBe("512");
  });

  it("normalise les clés d'entrée non préfixées", () => {
    const out = applyAnonymizationPlan({ "0010,0010": "DUPONT^Jean" });
    expect(out.x00100010).toBe(DEFAULT_PSEUDONYM);
    expect("0010,0010" in out).toBe(false);
  });
});

describe("applyAnonymizationPlan — options", () => {
  it("applique un pseudonyme personnalisé", () => {
    const out = applyAnonymizationPlan(
      { x00100010: "X", x00100020: "Y" },
      { pseudonym: "ID-9" }
    );
    expect(out.x00100010).toBe("ID-9");
    expect(out.x00100020).toBe("ID-9");
  });

  it("keepDates conserve PatientBirthDate / StudyDate", () => {
    const out = applyAnonymizationPlan(
      { x00100030: "19800101", x00080020: "20240101" },
      { keepDates: true }
    );
    expect(out.x00100030).toBe("19800101");
    expect(out.x00080020).toBe("20240101");
  });

  it("removePrivateTags retire les tags privés non couverts", () => {
    const out = applyAnonymizationPlan(
      { x00090010: "secret", x00100040: "F" },
      { removePrivateTags: true }
    );
    expect("x00090010" in out).toBe(false); // privé retiré
    expect(out.x00100040).toBe("F"); // public conservé
  });

  it("removePrivateTags ne retire pas un tag privé couvert par une règle keep", () => {
    const out = applyAnonymizationPlan(
      { x00090010: "garde" },
      {
        removePrivateTags: true,
        extraRules: [{ tag: "x00090010", name: "Priv", action: "keep" }],
      }
    );
    expect(out.x00090010).toBe("garde");
  });

  it("extraRules peut retirer un tag normalement conservé", () => {
    const out = applyAnonymizationPlan(
      { x00100040: "M" },
      { extraRules: [{ tag: "x00100040", name: "Sex", action: "remove" }] }
    );
    expect("x00100040" in out).toBe(false);
  });
});

describe("applyAnonymizationPlan — bords / dégénérés", () => {
  it("objet vide → objet vide", () => {
    expect(applyAnonymizationPlan({})).toEqual({});
  });

  it("ne mute pas la source", () => {
    const src = { x00100010: "DUPONT^Jean", x00100040: "M" };
    const snapshot = { ...src };
    applyAnonymizationPlan(src);
    expect(src).toEqual(snapshot);
  });

  it("est déterministe (deux appels identiques)", () => {
    const src = { x00100010: "A", x0020000d: "1.2", x00100040: "M" };
    expect(applyAnonymizationPlan(src)).toEqual(applyAnonymizationPlan(src));
  });

  it("conserve telle quelle une clé d'entrée non parsable", () => {
    const out = applyAnonymizationPlan({ "not-a-tag": "v" });
    expect(out["not-a-tag"]).toBe("v");
  });

  it("gère une valeur vide en entrée", () => {
    const out = applyAnonymizationPlan({ x00100010: "" });
    expect(out.x00100010).toBe(DEFAULT_PSEUDONYM); // replace inconditionnel
  });

  it("fusionne deux clés équivalentes (dernière gagne après normalisation)", () => {
    // x00100040 = keep ; les deux variantes de clé désignent le même tag.
    const out = applyAnonymizationPlan({ "0010,0040": "M", x00100040: "F" });
    expect(Object.keys(out)).toEqual(["x00100040"]);
    expect(out.x00100040).toBe("F");
  });
});
