import { describe, it, expect } from "vitest";
import { parseOllamaStreamLine } from "./stream";

describe("parseOllamaStreamLine", () => {
  it("extrait le delta de contenu", () => {
    expect(parseOllamaStreamLine('{"message":{"content":"ab"}}')).toBe("ab");
  });
  it("ligne done → null", () => {
    expect(parseOllamaStreamLine('{"done":true}')).toBeNull();
  });
  it("ligne vide → null", () => {
    expect(parseOllamaStreamLine("")).toBeNull();
    expect(parseOllamaStreamLine("   ")).toBeNull();
  });
  it("JSON invalide → null (ne jette pas)", () => {
    expect(parseOllamaStreamLine("{pas du json")).toBeNull();
  });
  it("contenu vide → null", () => {
    expect(parseOllamaStreamLine('{"message":{"content":""}}')).toBeNull();
  });
});
