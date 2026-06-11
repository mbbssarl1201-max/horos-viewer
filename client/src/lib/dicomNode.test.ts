import { describe, it, expect } from "vitest";
import {
  validateNode,
  formatNodeLabel,
  DICOM_NODE_ROLES,
  PORT_MIN,
  PORT_MAX,
  AET_MAX_LENGTH,
  type DicomNode,
} from "./dicomNode";

/** Fabrique un nœud valide, surchargé par `over`. */
function makeNode(over: Partial<DicomNode> = {}): DicomNode {
  return {
    aet: "ORTHANC",
    host: "192.168.1.180",
    port: 11112,
    role: "both",
    ...over,
  };
}

describe("constantes", () => {
  it("expose les bornes attendues", () => {
    expect(PORT_MIN).toBe(1);
    expect(PORT_MAX).toBe(65535);
    expect(AET_MAX_LENGTH).toBe(16);
    expect(DICOM_NODE_ROLES).toEqual(["qr", "store", "both"]);
  });
});

describe("validateNode — cas nominal", () => {
  it("accepte un nœud complet et valide", () => {
    const r = validateNode(makeNode());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it.each(["qr", "store", "both"] as const)("accepte le rôle %s", role => {
    expect(validateNode(makeNode({ role })).ok).toBe(true);
  });

  it("accepte un AET de longueur exactement 16", () => {
    const aet = "A".repeat(16);
    expect(validateNode(makeNode({ aet })).ok).toBe(true);
  });

  it("accepte un AET d'un seul caractère", () => {
    expect(validateNode(makeNode({ aet: "X" })).ok).toBe(true);
  });

  it("accepte un host de type nom DNS", () => {
    expect(validateNode(makeNode({ host: "pacs.cabinet.local" })).ok).toBe(
      true
    );
  });

  it.each([PORT_MIN, 104, 11112, PORT_MAX])("accepte le port %i", port => {
    expect(validateNode(makeNode({ port })).ok).toBe(true);
  });

  it("accepte une URL WADO valide", () => {
    expect(validateNode(makeNode({ wado: "https://pacs/wado" })).ok).toBe(true);
  });

  it("accepte wado absent, vide, null ou undefined", () => {
    expect(validateNode(makeNode({ wado: undefined })).ok).toBe(true);
    expect(validateNode(makeNode({ wado: "" })).ok).toBe(true);
    // @ts-expect-error — on teste la tolérance au null
    expect(validateNode(makeNode({ wado: null })).ok).toBe(true);
  });

  it("accepte un AET avec espace interne (ASCII imprimable)", () => {
    expect(validateNode(makeNode({ aet: "MY NODE" })).ok).toBe(true);
  });
});

describe("validateNode — AET invalide", () => {
  it("rejette un AET vide", () => {
    const r = validateNode(makeNode({ aet: "" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("AET requis");
  });

  it("rejette un AET composé uniquement d'espaces", () => {
    const r = validateNode(makeNode({ aet: "   " }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("AET requis");
  });

  it("rejette un AET avec espace de tête/queue", () => {
    expect(validateNode(makeNode({ aet: " ORTHANC" })).ok).toBe(false);
    expect(validateNode(makeNode({ aet: "ORTHANC " })).ok).toBe(false);
    const r = validateNode(makeNode({ aet: "ORTHANC " }));
    expect(r.errors).toContain(
      "AET ne doit pas comporter d'espace en tête ou en fin"
    );
  });

  it("rejette un AET de 17 caractères", () => {
    const aet = "A".repeat(17);
    const r = validateNode(makeNode({ aet }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.startsWith("AET trop long"))).toBe(true);
  });

  it("rejette un AET non-ASCII (accent)", () => {
    const r = validateNode(makeNode({ aet: "NŒUD" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("AET doit être en ASCII imprimable");
  });

  it("rejette un AET avec caractère de contrôle", () => {
    const r = validateNode(makeNode({ aet: "BAD\tTAB" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("AET doit être en ASCII imprimable");
  });

  it("rejette un AET d'un mauvais type", () => {
    // @ts-expect-error — type volontairement faux
    const r = validateNode(makeNode({ aet: 42 }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("AET requis");
  });
});

describe("validateNode — host invalide", () => {
  it("rejette un host vide", () => {
    const r = validateNode(makeNode({ host: "" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Hôte requis");
  });

  it("rejette un host d'espaces", () => {
    expect(validateNode(makeNode({ host: "  " })).errors).toContain(
      "Hôte requis"
    );
  });

  it("rejette un host d'un mauvais type", () => {
    // @ts-expect-error — type volontairement faux
    const r = validateNode(makeNode({ host: 123 }));
    expect(r.errors).toContain("Hôte requis");
  });
});

describe("validateNode — port invalide", () => {
  it("rejette le port 0 (hors plage)", () => {
    const r = validateNode(makeNode({ port: 0 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.startsWith("Port hors plage"))).toBe(true);
  });

  it("rejette un port > 65535", () => {
    const r = validateNode(makeNode({ port: 65536 }));
    expect(r.errors.some(e => e.startsWith("Port hors plage"))).toBe(true);
  });

  it("rejette un port négatif", () => {
    expect(validateNode(makeNode({ port: -1 })).ok).toBe(false);
  });

  it("rejette un port non entier", () => {
    const r = validateNode(makeNode({ port: 104.5 }));
    expect(r.errors).toContain("Port requis (entier)");
  });

  it("rejette un port NaN", () => {
    const r = validateNode(makeNode({ port: Number.NaN }));
    expect(r.errors).toContain("Port requis (entier)");
  });

  it("rejette un port Infinity", () => {
    const r = validateNode(makeNode({ port: Number.POSITIVE_INFINITY }));
    expect(r.errors).toContain("Port requis (entier)");
  });

  it("rejette un port d'un mauvais type", () => {
    // @ts-expect-error — type volontairement faux
    const r = validateNode(makeNode({ port: "11112" }));
    expect(r.errors).toContain("Port requis (entier)");
  });
});

describe("validateNode — role invalide", () => {
  it("rejette un rôle inconnu", () => {
    // @ts-expect-error — rôle hors union
    const r = validateNode(makeNode({ role: "send" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Rôle invalide (attendu : qr | store | both)");
  });

  it("rejette un rôle absent", () => {
    // @ts-expect-error — rôle manquant
    const r = validateNode(makeNode({ role: undefined }));
    expect(r.errors).toContain("Rôle invalide (attendu : qr | store | both)");
  });
});

describe("validateNode — wado invalide", () => {
  it("rejette une URL WADO non parsable", () => {
    const r = validateNode(makeNode({ wado: "pas une url" }));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("URL WADO invalide");
  });

  it("rejette une URL WADO relative", () => {
    const r = validateNode(makeNode({ wado: "/wado/rs" }));
    expect(r.errors).toContain("URL WADO invalide");
  });

  it("rejette un wado d'un mauvais type", () => {
    // @ts-expect-error — type volontairement faux
    const r = validateNode(makeNode({ wado: 123 }));
    expect(r.errors).toContain("URL WADO invalide");
  });
});

describe("validateNode — entrées dégénérées et erreurs multiples", () => {
  it("ne lève pas sur null / undefined et renvoie ok:false", () => {
    expect(validateNode(null).ok).toBe(false);
    expect(validateNode(undefined).ok).toBe(false);
    expect(validateNode({}).ok).toBe(false);
  });

  it("cumule toutes les erreurs d'un nœud entièrement invalide", () => {
    const r = validateNode({
      aet: "",
      host: "",
      port: 0,
      role: "x" as DicomNodeRole,
    });
    expect(r.ok).toBe(false);
    // 4 erreurs distinctes attendues (AET, host, port, role).
    expect(r.errors.length).toBe(4);
    expect(r.errors).toContain("AET requis");
    expect(r.errors).toContain("Hôte requis");
    expect(r.errors).toContain("Rôle invalide (attendu : qr | store | both)");
  });

  it("est déterministe (même entrée → même sortie)", () => {
    const n = makeNode({ port: 999999 });
    expect(validateNode(n)).toEqual(validateNode(n));
  });
});

describe("formatNodeLabel", () => {
  it("formate un nœud complet", () => {
    expect(formatNodeLabel(makeNode())).toBe(
      "ORTHANC@192.168.1.180:11112 (both)"
    );
  });

  it("remplace les champs absents par un tiret", () => {
    expect(formatNodeLabel({})).toBe("—@—:— (—)");
  });

  it("gère null / undefined sans lever", () => {
    expect(formatNodeLabel(null)).toBe("—@—:— (—)");
    expect(formatNodeLabel(undefined)).toBe("—@—:— (—)");
  });

  it("remplace un rôle invalide par un tiret", () => {
    const label = formatNodeLabel({
      aet: "A",
      host: "h",
      port: 1,
      role: "bad" as DicomNodeRole,
    });
    expect(label).toBe("A@h:1 (—)");
  });

  it("traite l'AET vide/espaces comme absent", () => {
    expect(formatNodeLabel(makeNode({ aet: "   " }))).toContain("—@");
  });

  it("rend le port même s'il est hors plage (cosmétique, ne valide pas)", () => {
    expect(formatNodeLabel(makeNode({ port: 70000 }))).toContain(":70000 ");
  });

  it("traite un port non fini comme absent", () => {
    expect(formatNodeLabel(makeNode({ port: Number.NaN }))).toContain(":— ");
  });
});
