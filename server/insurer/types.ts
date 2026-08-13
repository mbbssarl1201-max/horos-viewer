/** Résultat structuré de la lecture d'une demande d'assureur par le LLM. */
export interface ExtractionDemande {
  patient: {
    nom: string | null;
    prenom: string | null;
    /** Date de naissance telle que lue, format libre (normalisée au matching). */
    ddn: string | null;
    tel: string | null;
  };
  exams: {
    /** Modalité DICOM si déductible (CR, CT, MR, US, DX…), sinon null. */
    modalite: string | null;
    /** Date demandée telle que lue (normalisée au matching), sinon null. */
    dateDemandee: string | null;
    description: string | null;
  }[];
  refSinistre: string | null;
  /** Adresse email de réponse indiquée dans la demande, sinon null. */
  adresseReponse: string | null;
  /** 0..1 — confiance globale du modèle dans sa lecture. */
  confiance: number;
}
