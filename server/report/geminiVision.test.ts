import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "crypto";
import { extractGeminiText, createSignedJwt } from "./geminiVision";

describe("extractGeminiText", () => {
  it("extrait le texte d'une réponse generateContent", () => {
    const json = {
      candidates: [
        { content: { parts: [{ text: "142, " }, { text: "210" }] } },
      ],
    };
    expect(extractGeminiText(json)).toBe("142, 210");
  });

  it("null si structure absente/vide", () => {
    expect(extractGeminiText({})).toBeNull();
    expect(extractGeminiText({ candidates: [] })).toBeNull();
    expect(extractGeminiText(null)).toBeNull();
    expect(
      extractGeminiText({ candidates: [{ content: { parts: [] } }] })
    ).toBeNull();
  });

  it("ignore les parts sans texte (inlineData, etc.)", () => {
    expect(
      extractGeminiText({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: "x" } }, { text: "RAS" }],
            },
          },
        ],
      })
    ).toBe("RAS");
  });
});

describe("createSignedJwt (auth service account Vertex)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const sa = {
    client_email: "svc@optigps.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
  };

  it("produit un JWT RS256 vérifiable avec les bons champs", () => {
    const jwt = createSignedJwt(sa, 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    expect(s.length).toBeGreaterThan(10);
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.iss).toBe(sa.client_email);
    expect(payload.aud).toBe(sa.token_uri);
    expect(payload.scope).toBe(
      "https://www.googleapis.com/auth/cloud-platform"
    );
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.exp).toBe(1_700_003_600);
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});
