import { eq, inArray } from "drizzle-orm";
import { getDb, nameSearchKey } from "../db";
import { decryptField } from "../_core/crypto";
import { patients, studies } from "../../drizzle/schema";
import type { ExtractionDemande } from "./types";

const JOUR_MS = 86_400_000;
const FENETRE_JOURS = 7;

/**
 * Normalise une date texte vers `YYYYMMDD`. Accepte `JJ.MM.AAAA`, `JJ/MM/AAAA`
 * (ordre suisse) et `AAAA-MM-JJ` (ISO). `null` si absente ou invalide
 * (calendrier incohérent, ex. 31.02.2020).
 */
export function normaliserDate(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();

  const suisse = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (suisse) {
    const [, d, m, y] = suisse;
    return versYmd(y, m, d);
  }

  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return versYmd(y, m, d);
  }

  return null;
}

function versYmd(y: string, m: string, d: string): string | null {
  const yn = Number(y);
  const mn = Number(m);
  const dn = Number(d);
  if (!Number.isInteger(yn) || !Number.isInteger(mn) || !Number.isInteger(dn))
    return null;
  if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
  // Un Date.UTC qui "déborde" (ex. 31 février) roule sur le mois suivant :
  // on rejette en comparant les composantes reconstruites.
  const date = new Date(Date.UTC(yn, mn - 1, dn));
  if (
    date.getUTCFullYear() !== yn ||
    date.getUTCMonth() !== mn - 1 ||
    date.getUTCDate() !== dn
  )
    return null;
  return `${String(yn).padStart(4, "0")}${String(mn).padStart(2, "0")}${String(dn).padStart(2, "0")}`;
}

function dateUtcMs(ymd: string | null): number | null {
  if (!ymd || !/^\d{8}$/.test(ymd)) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  return Date.UTC(y, m - 1, d);
}

/**
 * Apparie un patient de la demande assureur à UN patient MediView par nom
 * (blind index, deux ordres) désambiguïsé par date de naissance.
 *
 * RÈGLE DURE : jamais "exact" sans DDN fournie ET concordante chiffre à
 * chiffre — la DDN seule (sans nom) ou le nom seul (sans DDN) ne suffisent
 * jamais à identifier un patient de façon certaine.
 */
export async function matchPatient(p: ExtractionDemande["patient"]): Promise<{
  statut: "exact" | "ambigu" | "aucun";
  patientId: number | null;
  candidats: number;
}> {
  const vide = { statut: "aucun" as const, patientId: null, candidats: 0 };
  const nom = (p.nom || "").trim();
  const prenom = (p.prenom || "").trim();
  if (!nom || !prenom) return vide;

  const db = await getDb();
  if (!db) return vide;

  const cles = Array.from(
    new Set(
      [
        nameSearchKey(`${nom} ${prenom}`),
        nameSearchKey(`${prenom} ${nom}`),
      ].filter((k): k is string => !!k)
    )
  );
  if (!cles.length) return vide;

  const candidats = await db
    .select()
    .from(patients)
    .where(inArray(patients.nameSearch, cles))
    .limit(50);
  if (!candidats.length) return vide;

  const ddn = normaliserDate(p.ddn);
  if (!ddn) {
    // Jamais "exact" sans DDN, même avec un seul homonyme trouvé.
    return { statut: "ambigu", patientId: null, candidats: candidats.length };
  }

  const correspondants = candidats.filter(c => {
    const b = (decryptField(c.birthDate) || "").replace(/\D/g, "");
    return b === ddn;
  });

  if (correspondants.length === 1) {
    return {
      statut: "exact",
      patientId: correspondants[0].id,
      candidats: candidats.length,
    };
  }
  if (correspondants.length > 1) {
    return {
      statut: "ambigu",
      patientId: null,
      candidats: correspondants.length,
    };
  }
  // Homonyme(s) trouvé(s) mais aucun ne concorde par DDN.
  return { statut: "aucun", patientId: null, candidats: candidats.length };
}

/**
 * Apparie chaque examen demandé aux études DICOM du patient déjà identifié :
 * même modalité (si fournie, tolère une modalité absente côté demande ou
 * étude), même `studyDate` exacte sinon à ±7 jours (`dateExacte: false`).
 */
export async function matchStudies(
  patientId: number,
  exams: ExtractionDemande["exams"]
): Promise<{
  tousTrouves: boolean;
  datesExactes: boolean;
  parExamen: {
    exam: ExtractionDemande["exams"][number];
    studyIds: number[];
    dateExacte: boolean;
  }[];
}> {
  if (!exams.length)
    return { tousTrouves: false, datesExactes: false, parExamen: [] };

  const db = await getDb();
  if (!db) {
    return {
      tousTrouves: false,
      datesExactes: false,
      parExamen: exams.map(exam => ({ exam, studyIds: [], dateExacte: false })),
    };
  }

  const etudes = await db
    .select()
    .from(studies)
    .where(eq(studies.patientId, patientId))
    .limit(500);

  const parExamen = exams.map(exam => {
    const modalite = (exam.modalite || "").trim().toUpperCase();
    const parModalite = modalite
      ? etudes.filter(e => (e.modality || "").toUpperCase() === modalite)
      : etudes;

    const dateVoulue = normaliserDate(exam.dateDemandee);
    if (!dateVoulue) {
      // Date absente/illisible : on ne bloque pas la validation humaine — on
      // renvoie les études de la modalité demandée (ou toutes si modalité
      // absente aussi) avec dateExacte:false, ce qui empêche tout envoi
      // automatique en aval (datesExactes global reste false).
      return { exam, studyIds: parModalite.map(e => e.id), dateExacte: false };
    }

    const exactes = parModalite.filter(e => e.studyDate === dateVoulue);
    if (exactes.length) {
      return { exam, studyIds: exactes.map(e => e.id), dateExacte: true };
    }

    const cibleMs = dateUtcMs(dateVoulue);
    const proches =
      cibleMs === null
        ? []
        : parModalite.filter(e => {
            const ms = dateUtcMs(e.studyDate);
            if (ms === null) return false;
            return Math.abs(ms - cibleMs) / JOUR_MS <= FENETRE_JOURS;
          });

    return { exam, studyIds: proches.map(e => e.id), dateExacte: false };
  });

  return {
    tousTrouves: parExamen.every(e => e.studyIds.length > 0),
    datesExactes: parExamen.every(e => e.dateExacte),
    parExamen,
  };
}
