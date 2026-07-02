import { describe, it, expect } from "vitest";
import { pickCrProvider } from "./crProvider";

describe("pickCrProvider — routage du moteur de CR", () => {
  const both = { claudeUsable: true, infomaniakUsable: true };

  it("auto (défaut/historique) : Infomaniak prioritaire", () => {
    expect(pickCrProvider({ crProvider: "auto", ...both })).toBe("infomaniak");
    expect(pickCrProvider({ crProvider: "", ...both })).toBe("infomaniak");
  });

  it("claude : route vers Claude sans retirer Infomaniak", () => {
    expect(pickCrProvider({ crProvider: "claude", ...both })).toBe("claude");
  });

  it("claude demandé mais non utilisable (pas de consentement) → repli historique", () => {
    expect(
      pickCrProvider({ crProvider: "claude", claudeUsable: false, infomaniakUsable: true })
    ).toBe("infomaniak");
  });

  it("aucun cloud utilisable → local (PHI-safe par défaut)", () => {
    expect(
      pickCrProvider({ crProvider: "auto", claudeUsable: false, infomaniakUsable: false })
    ).toBe("local");
    expect(
      pickCrProvider({ crProvider: "claude", claudeUsable: false, infomaniakUsable: false })
    ).toBe("local");
  });

  it("infomaniak explicite", () => {
    expect(pickCrProvider({ crProvider: "infomaniak", ...both })).toBe("infomaniak");
    expect(
      pickCrProvider({ crProvider: "infomaniak", claudeUsable: true, infomaniakUsable: false })
    ).toBe("claude");
  });
});
