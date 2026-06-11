import { describe, expect, it } from "vitest";
import { cutoffDate, buildAuditCsv, MIN_RETENTION_DAYS } from "./audit";

describe("cutoffDate (fenêtre de rétention)", () => {
  it("recule de N jours par rapport à now", () => {
    const now = new Date("2026-06-11T12:00:00.000Z");
    const cutoff = cutoffDate(now, 30);
    expect(cutoff.toISOString()).toBe("2026-05-12T12:00:00.000Z");
  });

  it("0 jour = maintenant", () => {
    const now = new Date("2026-06-11T00:00:00.000Z");
    expect(cutoffDate(now, 0).getTime()).toBe(now.getTime());
  });

  it("expose un plancher de rétention de 30 jours", () => {
    expect(MIN_RETENTION_DAYS).toBe(30);
  });
});

describe("buildAuditCsv (export CSV du journal d'accès)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 1,
    userId: 7,
    action: "study.view",
    studyId: 42,
    detail: null,
    ipAddress: "10.0.0.1",
    createdAt: new Date("2026-06-11T08:30:00.000Z"),
    ...over,
  });

  it("émet l'en-tête même sans ligne", () => {
    const csv = buildAuditCsv([]);
    expect(csv).toBe("id,userId,action,studyId,detail,ipAddress,createdAt");
  });

  it("sérialise une ligne (date ISO, valeurs nulles vides)", () => {
    const csv = buildAuditCsv([row() as any]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "1,7,study.view,42,,10.0.0.1,2026-06-11T08:30:00.000Z"
    );
  });

  it("échappe les champs contenant virgule/guillemet/saut de ligne", () => {
    const csv = buildAuditCsv([
      row({ detail: 'a,b "c"\nd', action: "x" }) as any,
    ]);
    const dataLine = csv.split("\n").slice(1).join("\n");
    // Le champ detail est entouré de guillemets et les " sont doublés.
    expect(dataLine).toContain('"a,b ""c""\nd"');
  });
});
