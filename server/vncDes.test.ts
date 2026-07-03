import { describe, expect, it } from "vitest";
import { desEncryptBlock, vncDESResponse } from "./vncDes";

describe("desEncryptBlock", () => {
  it("vecteur FIPS 81 : clé 0123456789ABCDEF, « Now is t » → 3FA40E8A984D4815", () => {
    const key = Buffer.from("0123456789ABCDEF", "hex");
    const plain = Buffer.from("Now is t", "ascii"); // 4E6F772069732074
    expect(desEncryptBlock(key, plain).toString("hex").toUpperCase()).toBe(
      "3FA40E8A984D4815"
    );
  });

  it("clé de zéros + bloc de zéros → 8CA64DE9C1B123A7 (vecteur classique)", () => {
    const zero = Buffer.alloc(8);
    expect(desEncryptBlock(zero, zero).toString("hex").toUpperCase()).toBe(
      "8CA64DE9C1B123A7"
    );
  });

  it("refuse une clé ou un bloc qui ne fait pas 8 octets", () => {
    expect(() => desEncryptBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow();
    expect(() => desEncryptBlock(Buffer.alloc(8), Buffer.alloc(9))).toThrow();
  });
});

describe("vncDESResponse", () => {
  it("produit 16 octets déterministes, sensibles au mot de passe", () => {
    const challenge = Buffer.from(
      "000102030405060708090a0b0c0d0e0f",
      "hex"
    );
    const a = vncDESResponse("secret", challenge);
    expect(a.length).toBe(16);
    expect(vncDESResponse("secret", challenge).equals(a)).toBe(true);
    expect(vncDESResponse("autre", challenge).equals(a)).toBe(false);
  });

  it("tronque le mot de passe à 8 caractères (règle VNC)", () => {
    const challenge = Buffer.alloc(16, 0x5a);
    expect(
      vncDESResponse("12345678ignoré", challenge).equals(
        vncDESResponse("12345678", challenge)
      )
    ).toBe(true);
  });

  it("inverse les bits de chaque octet de clé (mot de passe vide = clé zéro : 1er bloc = vecteur zéro connu)", () => {
    // password "" → clé 0x00…00 ; challenge nul → chaque bloc = DES(0,0).
    const out = vncDESResponse("", Buffer.alloc(16));
    expect(out.subarray(0, 8).toString("hex").toUpperCase()).toBe(
      "8CA64DE9C1B123A7"
    );
    expect(out.subarray(8, 16).toString("hex").toUpperCase()).toBe(
      "8CA64DE9C1B123A7"
    );
  });

  it("refuse un challenge qui ne fait pas 16 octets", () => {
    expect(() => vncDESResponse("x", Buffer.alloc(8))).toThrow();
  });
});
