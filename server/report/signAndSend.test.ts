import { describe, it, expect } from "vitest";
import { assertSendable } from "./signAndSend";

describe("garde envoi : pas d'envoi sans signature", () => {
  it("refuse si non signé", () => {
    expect(() => assertSendable("draft", "dr@x.ch")).toThrow(/signé/i);
  });
  it("refuse si e-mail manquant", () => {
    expect(() => assertSendable("signed", null)).toThrow(/e-mail/i);
  });
  it("accepte si signé + e-mail", () => {
    expect(() => assertSendable("signed", "dr@x.ch")).not.toThrow();
  });
});
