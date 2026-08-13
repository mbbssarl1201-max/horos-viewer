import { describe, expect, it, vi } from "vitest";

describe("env insurer", () => {
  it("parse les listes en minuscules et ignore le vide", async () => {
    vi.stubEnv("INSURER_TRUSTED_SENDERS", " A@b.ch ,, c@D.ch ");
    vi.stubEnv("INSURER_AUTO_SEND_DOMAINS", "SUVA.ch");
    vi.resetModules();
    const { ENV } = await import("../_core/env");
    expect(ENV.insurerTrustedSenders).toEqual(["a@b.ch", "c@d.ch"]);
    expect(ENV.insurerAutoSendDomains).toEqual(["suva.ch"]);
    vi.unstubAllEnvs();
  });
});
