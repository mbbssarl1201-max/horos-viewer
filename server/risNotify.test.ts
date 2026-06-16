import { describe, expect, it } from "vitest";
import { shouldNotify, PRIORITY_TRIGGERS, STATUS_TRIGGERS } from "./risNotify";

const RIS = "ris@example.com";

describe("shouldNotify (déclenchement notifications RIS)", () => {
  // Garde-fou opt-in : sans boîte RIS configurée, jamais d'envoi.
  it("ne notifie jamais quand RIS_NOTIFY_EMAIL est vide/absent", () => {
    expect(shouldNotify("routine", "stat", PRIORITY_TRIGGERS, "")).toBe(false);
    expect(shouldNotify("routine", "stat", PRIORITY_TRIGGERS, undefined)).toBe(
      false
    );
    expect(shouldNotify("reported", "finalized", STATUS_TRIGGERS, "")).toBe(
      false
    );
  });

  it("notifie sur une vraie transition vers un déclencheur (RIS configuré)", () => {
    expect(shouldNotify("routine", "stat", PRIORITY_TRIGGERS, RIS)).toBe(true);
    expect(shouldNotify("routine", "urgent", PRIORITY_TRIGGERS, RIS)).toBe(
      true
    );
    expect(shouldNotify("reported", "finalized", STATUS_TRIGGERS, RIS)).toBe(
      true
    );
  });

  it("ne notifie pas quand la valeur ne change pas (pas de transition)", () => {
    expect(shouldNotify("stat", "stat", PRIORITY_TRIGGERS, RIS)).toBe(false);
    expect(shouldNotify("finalized", "finalized", STATUS_TRIGGERS, RIS)).toBe(
      false
    );
  });

  it("ne notifie pas quand la nouvelle valeur n'est pas un déclencheur", () => {
    expect(shouldNotify("stat", "routine", PRIORITY_TRIGGERS, RIS)).toBe(false);
    expect(shouldNotify("new", "in_progress", STATUS_TRIGGERS, RIS)).toBe(
      false
    );
    expect(shouldNotify("new", "reported", STATUS_TRIGGERS, RIS)).toBe(false);
  });

  it("gère une valeur précédente nulle/indéfinie comme une transition", () => {
    expect(shouldNotify(null, "stat", PRIORITY_TRIGGERS, RIS)).toBe(true);
    expect(shouldNotify(undefined, "finalized", STATUS_TRIGGERS, RIS)).toBe(
      true
    );
  });
});
