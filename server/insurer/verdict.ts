// Verdict « simple » d'une demande assureur, pour l'affichage gérant :
// la seule question qui compte est « a-t-on le résultat demandé, oui ou non ? ».
// Les motifs techniques (expéditeur, dates rapprochées…) restent disponibles
// mais ne doivent plus être la première chose lue.

export type Verdict =
  | "disponible" // patient + examens trouvés, images présentes → prêt à envoyer
  | "preparation" // examens trouvés, images en cours de rapatriement du PACS
  | "introuvable" // patient inconnu OU aucun examen correspondant → pas chez nous
  | "envoyee"
  | "rejetee"
  | "en_cours"; // pas encore traitée (recue/extraite)

export function verdictDemande(args: {
  statut: string;
  patientId: number | null;
  studyIds: number[] | null;
  etudesSansImages: boolean;
}): Verdict {
  if (args.statut === "envoyee") return "envoyee";
  if (args.statut === "rejetee") return "rejetee";
  if (args.statut === "recue" || args.statut === "extraite") return "en_cours";
  if (!args.patientId || !(args.studyIds ?? []).length) return "introuvable";
  return args.etudesSansImages ? "preparation" : "disponible";
}
