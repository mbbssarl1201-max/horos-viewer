import { describe, it, expect } from "vitest";
import { buildShareNotification } from "./studyShare";

describe("buildShareNotification", () => {
  it("titre avec le nom de l'expéditeur", () => {
    const r = buildShareNotification("Dr Martin", "À relire SVP");
    expect(r.title).toContain("Dr Martin");
    expect(r.message).toBe("À relire SVP");
  });
  it("nom vide → « un confrère »", () => {
    expect(buildShareNotification("", undefined).title.toLowerCase()).toContain(
      "confrère"
    );
  });
  it("note absente → message vide", () => {
    expect(buildShareNotification("X").message).toBe("");
  });
  it("note tronquée à 1000 caractères", () => {
    expect(buildShareNotification("X", "y".repeat(2000)).message.length).toBe(
      1000
    );
  });
});
