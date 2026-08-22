import { describe, it, expect } from "vitest";
import { extractGeminiText } from "./geminiVision";

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
