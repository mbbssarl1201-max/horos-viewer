import { describe, expect, it } from "vitest";
import { validatePasswordChange } from "./passwordChange";

const VALID = {
  currentPassword: "ancien-mot-de-passe",
  newPassword: "nouveau-mot-de-passe",
  confirmPassword: "nouveau-mot-de-passe",
};

describe("validatePasswordChange", () => {
  it("accepte un formulaire valide", () => {
    expect(validatePasswordChange(VALID)).toBeNull();
  });

  it("exige le mot de passe actuel", () => {
    expect(validatePasswordChange({ ...VALID, currentPassword: "" })).toMatch(
      /actuel/
    );
  });

  it("refuse un nouveau mot de passe trop court (< 12)", () => {
    expect(
      validatePasswordChange({
        ...VALID,
        newPassword: "court",
        confirmPassword: "court",
      })
    ).toMatch(/12 caractères/);
  });

  it("refuse un nouveau mot de passe trop long (> 128)", () => {
    const long = "x".repeat(129);
    expect(
      validatePasswordChange({
        ...VALID,
        newPassword: long,
        confirmPassword: long,
      })
    ).toMatch(/128/);
  });

  it("refuse un nouveau mot de passe identique à l'actuel", () => {
    expect(
      validatePasswordChange({
        ...VALID,
        newPassword: VALID.currentPassword,
        confirmPassword: VALID.currentPassword,
      })
    ).toMatch(/différent/);
  });

  it("refuse une confirmation qui ne correspond pas", () => {
    expect(
      validatePasswordChange({ ...VALID, confirmPassword: "autre-chose-xyz" })
    ).toMatch(/confirmation/i);
  });

  it("vérifie la longueur AVANT l'égalité avec l'actuel (message le plus utile)", () => {
    expect(
      validatePasswordChange({
        currentPassword: "court",
        newPassword: "court",
        confirmPassword: "court",
      })
    ).toMatch(/12 caractères/);
  });
});
