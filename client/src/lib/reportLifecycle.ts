/** Sections d'un compte-rendu (alignées sur ReportSections de reportPdf.ts). */
export interface ReportSectionFields {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
}

export type ReportStatus = "draft" | "signed";

/** Sections minimales requises avant de pouvoir signer. */
export const REQUIRED_TO_SIGN: ReadonlyArray<keyof ReportSectionFields> = [
  "conclusion",
];

/** Un compte-rendu n'est éditable que tant qu'il est en brouillon. */
export function canEditReport(status: ReportStatus): boolean {
  return status === "draft";
}

/** Signature possible : brouillon + toutes les sections requises non vides. */
export function canSignReport(
  status: ReportStatus,
  sections: ReportSectionFields
): boolean {
  if (status !== "draft") return false;
  return REQUIRED_TO_SIGN.every(k => (sections[k] ?? "").trim().length > 0);
}

/** Les addenda ne s'ajoutent qu'à un compte-rendu signé. */
export function canAddAddendum(status: ReportStatus): boolean {
  return status === "signed";
}

/** Normalise un objet arbitraire (sortie IA) en 4 sections-chaînes sûres. */
export function validateReportSections(
  raw: Partial<Record<keyof ReportSectionFields, unknown>> | null | undefined
): ReportSectionFields {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    indication: s(raw?.indication),
    technique: s(raw?.technique),
    resultats: s(raw?.resultats),
    conclusion: s(raw?.conclusion),
  };
}
