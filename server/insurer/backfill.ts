// Backfill PACS → MediView : sélection des études dont les images doivent être
// rapatriées du PACS du cabinet. Voir docs/superpowers/specs/2026-08-14-backfill-pacs-design.md.
//
// Le cœur `selectionnerEtudesARapatrier` est PUR (aucune I/O) pour être testé
// sans base ; `etudesARapatrier` est la fine couche qui lit la base et l'espace
// disque puis délègue à ce cœur.
import { getDb } from "../db";

// Statuts d'une demande assureur pour lesquels on cherche encore à compléter le
// colis (non terminaux : ni envoyée, ni rejetée). Une étude réclamée par une
// telle demande et dépourvue d'images est candidate au rapatriement.
export const STATUTS_EN_ATTENTE = [
  "recue",
  "extraite",
  "identifiee",
  "prete",
  "a_valider",
  "erreur",
] as const;

// Sous le seuil d'espace libre, on suspend le rapatriement : un gros CT peut
// peser plusieurs Go et le VPS médical est souvent proche de la saturation
// (cf. mémoire medicentral-disque-incident). Mieux vaut une demande en attente
// qu'un disque plein qui casse toute la prod médicale.
export const SEUIL_ESPACE_LIBRE_OCTETS = 10 * 1024 * 1024 * 1024; // 10 Go
export const LIMITE_ETUDES = 50;

export type DemandeMinimale = {
  statut: string;
  studyIds: number[] | null;
};

export type EtudeMinimale = {
  id: number;
  studyInstanceUid: string;
  accessionNumber: string | null;
  numberOfInstances: number | null;
};

export type EtudeARapatrier = {
  studyInstanceUid: string;
  accessionNumber: string | null;
  /** Nombre d'images DÉJÀ présentes localement. La passerelle compare au PACS
   *  (C-FIND) et ne tire que si le PACS en a davantage → reprise automatique
   *  d'une étude partiellement rapatriée (C-GET interrompu sur Wi-Fi). */
  nbImagesLocal: number;
};

// Motif posé sur une demande dont au moins une étude trouvée est encore une
// fiche méta-seule (aucune image). Bloque l'envoi automatique et signale au
// gérant que le rapatriement du PACS est en cours.
export const MOTIF_IMAGES_A_RAPATRIER =
  "Images en cours de rapatriement du PACS";

/**
 * Vrai si au moins une des études données est dépourvue d'images
 * (`numberOfInstances` = 0). Sert de garde anti-colis-vide en amont, dès le
 * traitement de la demande assureur. Renvoie false pour une liste vide (l'échec
 * « aucune étude » est déjà géré par ailleurs).
 */
export async function etudesSansImages(studyIds: number[]): Promise<boolean> {
  if (!studyIds.length) return false;
  const db = await getDb();
  if (!db) return false;
  const schema = await import("../../drizzle/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ numberOfInstances: schema.studies.numberOfInstances })
    .from(schema.studies)
    .where(inArray(schema.studies.id, studyIds));
  return rows.some(r => ((r.numberOfInstances as number | null) ?? 0) === 0);
}

/**
 * Cœur pur : à partir des demandes en attente, des études connues et de
 * l'espace disque libre, renvoie les UID d'études à rapatrier (études sans
 * aucune image, réclamées par au moins une demande non terminale), dédupliquées
 * et bornées. Renvoie une liste VIDE si l'espace libre est sous le seuil.
 */
export function selectionnerEtudesARapatrier(
  demandes: DemandeMinimale[],
  etudesParId: Map<number, EtudeMinimale>,
  espaceLibreOctets: number,
  limite = LIMITE_ETUDES
): EtudeARapatrier[] {
  if (espaceLibreOctets < SEUIL_ESPACE_LIBRE_OCTETS) return [];

  const enAttente = new Set<string>(STATUTS_EN_ATTENTE);
  const vus = new Set<number>();
  const resultat: EtudeARapatrier[] = [];

  for (const d of demandes) {
    if (!enAttente.has(d.statut)) continue;
    for (const studyId of d.studyIds ?? []) {
      if (vus.has(studyId)) continue;
      vus.add(studyId);
      const etude = etudesParId.get(studyId);
      // Étude inconnue (fiche pas encore poussée) : rien à tirer pour l'instant.
      // On renvoie AUSSI les études déjà pourvues d'images, avec leur compte
      // local : la passerelle compare au PACS et ne re-tire que si celui-ci en
      // a plus (reprise d'un rapatriement interrompu). Une étude complète est
      // donc renvoyée mais la passerelle la sautera après un simple C-FIND.
      if (!etude) continue;
      resultat.push({
        studyInstanceUid: etude.studyInstanceUid,
        accessionNumber: etude.accessionNumber,
        nbImagesLocal: etude.numberOfInstances ?? 0,
      });
      if (resultat.length >= limite) return resultat;
    }
  }
  return resultat;
}

/**
 * Couche base : charge les demandes non terminales + les études référencées,
 * puis délègue au cœur pur. `espaceLibreOctets` est fourni par l'appelant
 * (sonde disque du serveur) pour rester testable et sans dépendance OS ici.
 */
export async function etudesARapatrier(
  espaceLibreOctets: number,
  limite = LIMITE_ETUDES
): Promise<EtudeARapatrier[]> {
  const db = await getDb();
  if (!db) return [];

  const schema = await import("../../drizzle/schema");
  const { inArray } = await import("drizzle-orm");

  const demandesBrutes = await db
    .select({
      statut: schema.insurerRequests.statut,
      studyIds: schema.insurerRequests.studyIds,
    })
    .from(schema.insurerRequests)
    .where(inArray(schema.insurerRequests.statut, [...STATUTS_EN_ATTENTE]));

  const demandes: DemandeMinimale[] = demandesBrutes.map(d => ({
    statut: d.statut as string,
    studyIds: (d.studyIds as number[] | null) ?? null,
  }));

  const idsReferences = Array.from(
    new Set(demandes.flatMap(d => d.studyIds ?? []))
  );
  if (!idsReferences.length) return [];

  const etudesBrutes = await db
    .select({
      id: schema.studies.id,
      studyInstanceUid: schema.studies.studyInstanceUid,
      accessionNumber: schema.studies.accessionNumber,
      numberOfInstances: schema.studies.numberOfInstances,
    })
    .from(schema.studies)
    .where(inArray(schema.studies.id, idsReferences));

  const etudesParId = new Map<number, EtudeMinimale>(
    etudesBrutes.map(e => [
      e.id as number,
      {
        id: e.id as number,
        studyInstanceUid: e.studyInstanceUid as string,
        accessionNumber: (e.accessionNumber as string | null) ?? null,
        numberOfInstances: (e.numberOfInstances as number | null) ?? 0,
      },
    ])
  );

  return selectionnerEtudesARapatrier(
    demandes,
    etudesParId,
    espaceLibreOctets,
    limite
  );
}
