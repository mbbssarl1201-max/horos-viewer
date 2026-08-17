// Filtre anatomique du matching assureur : ne retenir QUE les examens dont le
// contenu correspond à la région demandée par l'assureur (« CT pied/chevilles »
// ⇒ pas un CT abdomen fait la même semaine). Lexique FR + termes DICOM usuels
// (EN), sans accents. Cœur PUR, testé isolément.

const REGIONS: Record<string, string[]> = {
  cheville_pied: [
    "cheville",
    "chevilles",
    "pied",
    "pieds",
    "ankle",
    "foot",
    "feet",
    "calcaneum",
    "calcaneus",
    "tarse",
    "metatars*",
    "orteil",
    "hallux",
  ],
  main_poignet: [
    "poignet",
    "main",
    "mains",
    "wrist",
    "hand",
    "carpe",
    "scaphoide",
    "metacarp*",
    "doigt",
    "pouce",
    "finger",
  ],
  epaule_bras: [
    "epaule",
    "shoulder",
    "bras",
    "humerus",
    "clavicule",
    "clavicle",
    "omoplate",
    "scapula",
    "acromio*",
  ],
  coude_avantbras: [
    "coude",
    "elbow",
    "avant-bras",
    "avant bras",
    "radius",
    "cubitus",
    "ulna",
    "forearm",
  ],
  genou_jambe: [
    "genou",
    "knee",
    "jambe",
    "tibia",
    "perone",
    "fibula",
    "rotule",
    "patella",
    "menisque",
  ],
  hanche_bassin: [
    "hanche",
    "hip",
    "bassin",
    "pelvis",
    "pelvien",
    "femur",
    "cotyle",
    "sacro-iliaque",
    "pubis",
  ],
  rachis: [
    "colonne",
    "rachis",
    "spine",
    "vertebr*",
    "lombaire",
    "lombalgie",
    "lumbar",
    "dorsale",
    "dorsal",
    "thoracique",
    "sacrum",
    "coccyx",
    "lws",
    "bws",
    "hws",
    // Le rachis cervical vit dans le cou : une étude « Neck » (étiquette
    // machine fréquente) peut être la colonne cervicale demandée.
    "cervical*",
    "neck",
    "hals",
  ],
  crane: [
    "crane",
    "neurocrane",
    "tete",
    "skull",
    "head",
    "cerveau",
    "cerebral",
    "brain",
    "encephal*",
    "schadel",
    "sinus",
    "massif facial",
    "orbite",
  ],
  cou: ["cou", "neck", "cervical*", "carotide", "thyroide", "larynx", "hals"],
  thorax: [
    "thorax",
    "chest",
    "poumon",
    "pulmonaire",
    "lung",
    "cotes",
    "sternum",
    "mediastin",
  ],
  abdomen: [
    "abdomen",
    "abdo*",
    "ventre",
    "foie",
    "hepatique",
    "rein",
    "renal",
    "pancreas",
    "rate",
    "intestin*",
    "colon",
    "uro*",
    "vessie",
  ],
};

function normaliser(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Correspondance par MOTS ENTIERS (bornes non-alphabétiques des deux côtés) —
// sinon « colonne » matcherait « colon » (abdomen). Les entrées marquées d'une
// « * » finale sont des préfixes volontaires (metatars* → métatarse/-ien…) :
// borne à gauche seulement.
function motPresent(texte: string, mot: string): boolean {
  const prefixe = mot.endsWith("*");
  const brut = prefixe ? mot.slice(0, -1) : mot;
  const echappe = brut.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z])${echappe}${prefixe ? "" : "($|[^a-z])"}`);
  return re.test(texte);
}

/** Régions anatomiques détectées dans un texte libre (description d'examen,
 *  libellés de séries…). Vide = aucun indice anatomique. */
export function regionsDe(texte: string): Set<string> {
  const t = normaliser(texte);
  const out = new Set<string>();
  for (const [region, mots] of Object.entries(REGIONS)) {
    if (mots.some(m => motPresent(t, m))) out.add(region);
  }
  return out;
}

export type CandidatAnatomique = {
  studyId: number;
  /** Texte descriptif de l'étude : studyDescription + libellés de séries. */
  libelles: string;
};

/**
 * Filtre les études candidates d'UN examen demandé selon la région anatomique :
 * - la demande n'a pas d'indice anatomique → aucune restriction (tout passe) ;
 * - une étude qui mentionne la région demandée est retenue (explicite) ;
 * - une étude SANS indice anatomique est retenue seulement s'il n'existe pas de
 *   correspondance explicite (ex. séries « OS Hi Resolution » sans région) ;
 * - une étude qui mentionne UNIQUEMENT d'autres régions est ÉCARTÉE
 *   (contradiction : un CT abdomen n'est pas le CT cheville demandé).
 */
export function filtrerParAnatomie(
  descriptionDemandee: string,
  candidats: CandidatAnatomique[]
): number[] {
  const demande = regionsDe(descriptionDemandee);
  if (!demande.size) return candidats.map(c => c.studyId);

  const explicites: number[] = [];
  const inconnues: number[] = [];
  for (const c of candidats) {
    const regs = regionsDe(c.libelles);
    if (!regs.size) {
      inconnues.push(c.studyId);
      continue;
    }
    const intersecte = Array.from(regs).some(r => demande.has(r));
    if (intersecte) explicites.push(c.studyId);
    // sinon : contradiction → écartée
  }
  return explicites.length ? explicites : inconnues;
}
