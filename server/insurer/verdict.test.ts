import { describe, it, expect } from "vitest";
import { verdictDemande } from "./verdict";

describe("verdictDemande", () => {
  it("disponible : patient + études + images", () => {
    expect(
      verdictDemande({
        statut: "a_valider",
        patientId: 5,
        studyIds: [1],
        etudesSansImages: false,
      })
    ).toBe("disponible");
  });

  it("preparation : études trouvées mais images pas encore rapatriées", () => {
    expect(
      verdictDemande({
        statut: "a_valider",
        patientId: 5,
        studyIds: [1],
        etudesSansImages: true,
      })
    ).toBe("preparation");
  });

  it("introuvable : patient non identifié", () => {
    expect(
      verdictDemande({
        statut: "a_valider",
        patientId: null,
        studyIds: [],
        etudesSansImages: false,
      })
    ).toBe("introuvable");
  });

  it("introuvable : patient identifié mais aucune étude", () => {
    expect(
      verdictDemande({
        statut: "a_valider",
        patientId: 5,
        studyIds: [],
        etudesSansImages: false,
      })
    ).toBe("introuvable");
  });

  it("statuts terminaux et en cours conservés", () => {
    const base = { patientId: 5, studyIds: [1], etudesSansImages: false };
    expect(verdictDemande({ ...base, statut: "envoyee" })).toBe("envoyee");
    expect(verdictDemande({ ...base, statut: "rejetee" })).toBe("rejetee");
    expect(verdictDemande({ ...base, statut: "recue" })).toBe("en_cours");
  });
});
