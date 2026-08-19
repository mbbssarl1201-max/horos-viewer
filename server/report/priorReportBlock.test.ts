import { describe, it, expect } from "vitest";
import { buildPriorReportBlock } from "./priorReportBlock";

describe("buildPriorReportBlock — texte du CR antérieur injecté au comparatif", () => {
  it("inclut la conclusion d'un CR SIGNÉ (avec sa date)", () => {
    const block = buildPriorReportBlock([
      {
        date: "2025-11-03",
        status: "signed",
        conclusion: "Nodule pulmonaire lobaire supérieur droit, 6 mm.",
      },
    ]);
    expect(block).toBeTruthy();
    expect(block!).toContain("2025-11-03");
    expect(block!).toContain(
      "Nodule pulmonaire lobaire supérieur droit, 6 mm."
    );
  });

  it("EXCLUT un brouillon (draft) — garde-fou : jamais se comparer à une IA non validée", () => {
    const block = buildPriorReportBlock([
      {
        date: "2025-11-03",
        status: "draft",
        conclusion: "Conclusion non validée générée par IA.",
      },
    ]);
    expect(block).toBeUndefined();
  });

  it("renvoie undefined si aucun CR signé exploitable (liste vide ou conclusions vides)", () => {
    expect(buildPriorReportBlock([])).toBeUndefined();
    expect(
      buildPriorReportBlock([
        { date: "2025-01-01", status: "signed", conclusion: "   " },
      ])
    ).toBeUndefined();
  });
});
