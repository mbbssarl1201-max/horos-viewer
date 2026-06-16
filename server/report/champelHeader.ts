import { readFileSync } from "fs";
import { join } from "path";

/** Coordonnées officielles du cabinet (en-tête fixe du compte rendu). */
export const CHAMPEL_HEADER = {
  name: "Institut de Champel",
  address: "2 rue Firmin Massot",
  city: "1206 Genève",
  phone: "+41 22 347 29 30",
  email: "contact@medecin-champel.ch",
  motto: "Ne cesseris umquam",
};

/**
 * Blason en data-URL PNG pour jsPDF.addImage. L'asset est copié dans
 * client/public/blason-champel.png (Task 1) et embarqué au build serveur via
 * une lecture au démarrage. Chemin résolu relativement au cwd du conteneur
 * (dist/) ; on tente plusieurs emplacements et on renvoie null si introuvable
 * (le PDF se génère alors sans blason, en-tête texte uniquement).
 */
export function getChampelBlasonDataUrl(): string | null {
  const candidates = [
    join(process.cwd(), "dist/public/blason-champel.png"),
    join(process.cwd(), "client/public/blason-champel.png"),
    join(process.cwd(), "public/blason-champel.png"),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      /* essaie le suivant */
    }
  }
  return null;
}
