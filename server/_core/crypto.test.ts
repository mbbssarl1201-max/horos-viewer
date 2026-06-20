import { describe, it, expect, beforeAll } from "vitest";

// Clé de test (32 octets base64) avant import du module (lu au chargement d'ENV).
beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("crypto champs patient", () => {
  it("chiffre/déchiffre un champ aléatoire (round-trip)", async () => {
    const { encryptField, decryptField } = await import("./crypto");
    const ct = encryptField("ADNAN BRANKOVICH");
    expect(ct).not.toBe("ADNAN BRANKOVICH");
    expect(ct?.startsWith("v1:")).toBe(true);
    expect(decryptField(ct)).toBe("ADNAN BRANKOVICH");
  });

  it("l'IV aléatoire produit des chiffrés différents pour le même clair", async () => {
    const { encryptField } = await import("./crypto");
    expect(encryptField("x")).not.toBe(encryptField("x"));
  });

  it("le déterministe est stable (égalité en base possible)", async () => {
    const { encryptDeterministic, decryptField } = await import("./crypto");
    const a = encryptDeterministic("998888");
    const b = encryptDeterministic("998888");
    expect(a).toBe(b);
    expect(a?.startsWith("d1:")).toBe(true);
    expect(decryptField(a)).toBe("998888");
    expect(encryptDeterministic("998888")).not.toBe(
      encryptDeterministic("999999")
    );
  });

  it("préserve null/undefined", async () => {
    const { encryptField, encryptDeterministic, decryptField } = await import(
      "./crypto"
    );
    expect(encryptField(null)).toBeNull();
    expect(encryptDeterministic(undefined)).toBeNull();
    expect(decryptField(null)).toBeNull();
  });

  it("laisse passer le clair non préfixé (donnée non migrée)", async () => {
    const { decryptField } = await import("./crypto");
    expect(decryptField("ADNAN BRANKOVICH")).toBe("ADNAN BRANKOVICH");
    expect(decryptField("19780118")).toBe("19780118");
  });

  it("rejette un chiffré altéré (intégrité GCM)", async () => {
    const { encryptField, decryptField } = await import("./crypto");
    const ct = encryptField("secret")!;
    const tampered = ct.slice(0, -4) + (ct.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptField(tampered)).toThrow();
  });
});
