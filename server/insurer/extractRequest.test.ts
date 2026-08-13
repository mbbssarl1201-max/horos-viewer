import { describe, expect, it } from "vitest";
import { parseReponseLlm } from "./extractRequest";

const REPONSE = JSON.stringify({
  patient: {
    nom: "Dupont",
    prenom: "Marie",
    ddn: "12.03.1985",
    tel: "079 555 12 34",
  },
  exams: [
    {
      modalite: "CT",
      dateDemandee: "02.06.2026",
      description: "CT colonne lombaire",
    },
  ],
  refSinistre: "12.34567.89",
  adresseReponse: "dossier@suva.ch",
  confiance: 0.93,
});

describe("parseReponseLlm", () => {
  it("parse une réponse JSON propre", () => {
    const r = parseReponseLlm(REPONSE);
    expect(r.patient.nom).toBe("Dupont");
    expect(r.exams).toHaveLength(1);
  });
  it("tolère un JSON dans une clôture markdown", () => {
    const r = parseReponseLlm("```json\n" + REPONSE + "\n```");
    expect(r.patient.prenom).toBe("Marie");
  });
  it("rejette (confiance 0, champs null) un contenu non-JSON", () => {
    const r = parseReponseLlm("désolé je ne peux pas");
    expect(r.confiance).toBe(0);
    expect(r.patient.nom).toBeNull();
  });
  it("borne les types : exams non-tableau ⇒ []", () => {
    const r = parseReponseLlm(JSON.stringify({ patient: {}, exams: "oui" }));
    expect(r.exams).toEqual([]);
  });
});
