/**
 * Modèles de compte rendu structurés (radiologie). Déterministes — squelettes que
 * le médecin remplit. Incluent les systèmes de classification standard (BI-RADS,
 * Fleischner, LI-RADS) pour des rapports normalisés. Aucune IA, aucun risque.
 */
export interface ReportTemplate {
  id: string;
  label: string;
  sections: { technique: string; resultats: string; conclusion: string };
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: "ct_thorax",
    label: "Scanner thoracique",
    sections: {
      technique:
        "Acquisition tomodensitométrique thoracique en coupes axiales, [avec / sans] injection de produit de contraste iodé.",
      resultats:
        "Parenchyme pulmonaire : \nPlèvre : pas d'épanchement / épanchement [côté].\nMédiastin : pas d'adénomégalie de taille significative.\nCœur et gros vaisseaux : \nParoi thoracique et structures osseuses : ",
      conclusion: "",
    },
  },
  {
    id: "ct_abdomen",
    label: "Scanner abdomino-pelvien",
    sections: {
      technique:
        "Acquisition tomodensitométrique abdomino-pelvienne, [temps portal / sans injection].",
      resultats:
        "Foie : taille et contours normaux, pas de lésion focale.\nVésicule / voies biliaires : \nPancréas : \nRate : \nReins et voies urinaires : \nDigestif : \nPéritoine / adénopathies : \nStructures osseuses : ",
      conclusion: "",
    },
  },
  {
    id: "ct_crane",
    label: "Scanner cérébral",
    sections: {
      technique: "Acquisition tomodensitométrique cérébrale sans injection.",
      resultats:
        "Pas d'hémorragie intra- ou extra-axiale.\nParenchyme : pas de lésion focale, différenciation substance grise/blanche conservée.\nSystème ventriculaire : de taille et de morphologie normales.\nPas d'effet de masse ni d'engagement.\nStructures osseuses / sinus : ",
      conclusion: "",
    },
  },
  {
    id: "birads",
    label: "Mammographie (BI-RADS)",
    sections: {
      technique:
        "Mammographie numérique bilatérale, incidences face et oblique externe [± échographie].",
      resultats:
        "Densité mammaire (ACR) : [A / B / C / D].\nSein droit : \nSein gauche : \nMasse / micro-calcifications / distorsion : ",
      conclusion:
        "Classification ACR BI-RADS : [0 / 1 / 2 / 3 / 4 / 5].\nConduite à tenir : ",
    },
  },
  {
    id: "fleischner",
    label: "Nodule pulmonaire (Fleischner)",
    sections: {
      technique: "Scanner thoracique en coupes fines.",
      resultats:
        "Nodule : localisation [lobe], taille [mm], type [solide / partiellement solide / verre dépoli].\nAutres nodules : ",
      conclusion:
        "Recommandation de suivi selon Fleischner 2017 (fonction de la taille, du type et du risque) : [pas de suivi / scanner de contrôle à X mois].",
    },
  },
  {
    id: "lirads",
    label: "Foie cirrhotique (LI-RADS)",
    sections: {
      technique:
        "IRM / scanner hépatique multiphasique avec injection (artériel, portal, tardif).",
      resultats:
        "Foie de morphologie [normale / dysmorphique].\nLésion : segment, taille [mm], rehaussement artériel, wash-out, capsule, croissance.",
      conclusion:
        "Catégorie LI-RADS : [LR-1 à LR-5 / LR-M / LR-TIV].\nConduite à tenir : ",
    },
  },
  {
    id: "irm_cerebrale",
    label: "IRM cérébrale",
    sections: {
      technique:
        "IRM cérébrale, séquences [T1, T2, FLAIR, diffusion, T2*, ± injection de gadolinium].",
      resultats:
        "Pas de lésion ischémique récente en diffusion.\nSubstance blanche : \nSystème ventriculaire et espaces péricérébraux : \nPas de prise de contraste anormale.\nFosse postérieure / structures médianes : ",
      conclusion: "",
    },
  },
];
