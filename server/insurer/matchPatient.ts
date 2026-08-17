import { eq, inArray } from "drizzle-orm";
import { getDb, nameSearchKey } from "../db";
import { decryptField } from "../_core/crypto";
import { patients, studies, series } from "../../drizzle/schema";
import { filtrerParAnatomie } from "./anatomie";
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
/** Normalisation locale identique à celle du blind index (db.normalizeName). */
function normaliserNom(s: string): string {
  return s
    .replace(/\^/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Distance de Levenshtein bornée (suffit pour ≤2). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Compatibilité de noms pour le repli par DDN : chaque token de la liste la
 * plus COURTE doit s'apparier à un token de l'autre (exact, préfixe ≥3, ou
 * Levenshtein ≤2 sur des tokens ≥4 lettres — couvre les translittérations type
 * « Dzuka »/« Xhuka »), avec AU MOINS un appariement exact. Les tokens
 * surnuméraires (2ᵉ nom de famille, nom d'épouse…) sont tolérés.
 */
export function nomsCompatibles(a: string, b: string): boolean {
  const ta = normaliserNom(a)
    .split(/[\s-]+/)
    .filter(t => t.length > 1);
  const tb = normaliserNom(b)
    .split(/[\s-]+/)
    .filter(t => t.length > 1);
  if (!ta.length || !tb.length) return false;
  const [courts, longs] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let exact = 0;
  for (const t of courts) {
    const ok = longs.some(u => {
      if (u === t) {
        return true;
      }
      if (t.length >= 3 && (u.startsWith(t) || t.startsWith(u))) return true;
      return t.length >= 4 && u.length >= 4 && levenshtein(t, u) <= 2;
    });
    if (!ok) return false;
    if (longs.includes(t)) exact++;
  }
  return exact >= 1;
}

export async function matchPatient(p: ExtractionDemande["patient"]): Promise<{
  statut: "exact" | "ambigu" | "aucun";
  patientId: number | null;
  /** TOUS les dossiers (doublons PACS) de la même personne — pour matchStudies. */
  patientIds: number[];
  /** Vrai si apparié par le repli DDN+variante d'orthographe (jamais d'auto). */
  variante: boolean;
  /** Vrai si le dossier n'a AUCUNE date de naissance pour confirmer (jamais d'auto). */
  ddnAbsente: boolean;
  candidats: number;
}> {
  const vide = {
    statut: "aucun" as const,
    patientId: null,
    patientIds: [],
    variante: false,
    ddnAbsente: false,
    candidats: 0,
  };
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

  const ddn = normaliserDate(p.ddn);
  if (candidats.length && !ddn) {
    // Jamais "exact" sans DDN, même avec un seul homonyme trouvé.
    return { ...vide, statut: "ambigu", candidats: candidats.length };
  }

  if (candidats.length && ddn) {
    const avecDdn = candidats.map(c => ({
      id: c.id,
      ddn: (decryptField(c.birthDate) || "").replace(/\D/g, ""),
    }));
    const confirmes = avecDdn.filter(c => c.ddn === ddn);
    const sansDdn = avecDdn.filter(c => !c.ddn);
    const conflits = avecDdn.filter(c => c.ddn && c.ddn !== ddn);

    if (confirmes.length) {
      // Le PACS du cabinet contient beaucoup de dossiers en DOUBLE (même
      // personne, plusieurs patientId) : même nom + même DDN = même personne,
      // on renvoie TOUS ses dossiers pour que la recherche d'études les couvre.
      // Les fiches homonymes SANS DDN ne sont rattachées que s'il n'existe
      // aucun homonyme d'une AUTRE personne (DDN différente) — sinon on ne
      // peut pas trancher à qui elles appartiennent.
      const ids = [
        ...confirmes.map(c => c.id),
        ...(conflits.length ? [] : sansDdn.map(c => c.id)),
      ];
      return {
        statut: "exact",
        patientId: ids[0],
        patientIds: ids,
        variante: false,
        ddnAbsente: false,
        candidats: candidats.length,
      };
    }
    if (sansDdn.length && !conflits.length) {
      // Nom trouvé de façon UNIQUE mais les fiches (souvent issues du backfill
      // PACS) n'ont pas de date de naissance enregistrée : on identifie quand
      // même — sans aucun homonyme conflictuel, c'est la seule personne de ce
      // nom — mais ddnAbsente force un motif et interdit l'envoi automatique.
      return {
        statut: "exact",
        patientId: sansDdn[0].id,
        patientIds: sansDdn.map(c => c.id),
        variante: false,
        ddnAbsente: true,
        candidats: candidats.length,
      };
    }
    // Sinon : homonymes d'autres personnes → repli variante ci-dessous.
  }

  // REPLI variantes d'orthographe : la feuille SUVA et le PACS écrivent parfois
  // le même patient différemment (« Dzuka »/« Xhuka », nom d'épouse ajouté,
  // ordre inversé…). Exigences STRICTES pour ne jamais prendre le mauvais
  // patient : DDN exacte obligatoire + noms compatibles (cf. nomsCompatibles).
  // Coût : un scan déchiffré (~7k dossiers), uniquement quand l'index échoue.
  if (!ddn) return vide;
  const tous = await db.select().from(patients).limit(20000);
  const feuille = `${prenom} ${nom}`;
  const compatibles = tous.filter(c => {
    const b = (decryptField(c.birthDate) || "").replace(/\D/g, "");
    if (b !== ddn) return false;
    const nomDossier = decryptField(c.patientName) || "";
    return nomsCompatibles(feuille, nomDossier);
  });
  if (compatibles.length) {
    return {
      statut: "exact",
      patientId: compatibles[0].id,
      patientIds: compatibles.map(c => c.id),
      variante: true,
      ddnAbsente: false,
      candidats: compatibles.length,
    };
  }

  // Dernier repli : fiches SANS DDN (fréquentes dans le backfill PACS — la
  // machine n'enregistre pas toujours la date de naissance) dont le nom est
  // compatible avec la feuille. Accepté UNIQUEMENT sans ambiguïté possible :
  //  - aucun homonyme compatible porteur d'une AUTRE DDN (sinon la fiche sans
  //    DDN pourrait appartenir à cette autre personne) ;
  //  - toutes les fiches candidates compatibles ENTRE ELLES (doublons PACS de
  //    la même personne), sinon on ne peut pas trancher.
  // ddnAbsente + variante ⇒ motifs de validation, jamais d'envoi automatique.
  const conflitAutreDdn = tous.some(c => {
    const b = (decryptField(c.birthDate) || "").replace(/\D/g, "");
    if (!b || b === ddn) return false;
    return nomsCompatibles(feuille, decryptField(c.patientName) || "");
  });
  if (!conflitAutreDdn) {
    const sansDdnCompat = tous.filter(c => {
      const b = (decryptField(c.birthDate) || "").replace(/\D/g, "");
      if (b) return false;
      return nomsCompatibles(feuille, decryptField(c.patientName) || "");
    });
    const noms = sansDdnCompat.map(c => decryptField(c.patientName) || "");
    const memePersonne =
      sansDdnCompat.length > 0 &&
      noms.every(n => noms.every(m => nomsCompatibles(n, m)));
    if (memePersonne) {
      return {
        statut: "exact",
        patientId: sansDdnCompat[0].id,
        patientIds: sansDdnCompat.map(c => c.id),
        variante: true,
        ddnAbsente: true,
        candidats: sansDdnCompat.length,
      };
    }
  }
  return { ...vide, candidats: candidats.length };
}

/**
 * Apparie chaque examen demandé aux études DICOM du patient déjà identifié :
 * même modalité (si fournie, tolère une modalité absente côté demande ou
 * étude), même `studyDate` exacte sinon à ±7 jours (`dateExacte: false`).
 */
export async function matchStudies(
  // Un numéro seul (compat) ou TOUS les dossiers d'une même personne
  // (doublons PACS, cf. matchPatient.patientIds).
  patientId: number | number[],
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

  const ids = Array.isArray(patientId) ? patientId : [patientId];
  const etudes = ids.length
    ? await db
        .select()
        .from(studies)
        .where(inArray(studies.patientId, ids))
        .limit(500)
    : [];

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

  // Filtre ANATOMIQUE : l'assureur demande un examen précis (« CT pied /
  // chevilles ») — un CT abdomen fait la même semaine ne doit JAMAIS être
  // retenu à sa place. On confronte la description demandée aux libellés
  // réels (studyDescription + séries + bodyPart) de chaque candidate.
  const idsCandidats = Array.from(new Set(parExamen.flatMap(e => e.studyIds)));
  if (idsCandidats.length) {
    const seriesRows = await db
      .select()
      .from(series)
      .where(inArray(series.studyId, idsCandidats))
      .limit(2000);
    const libellesParEtude = new Map<number, string>();
    for (const e of etudes) {
      if (idsCandidats.includes(e.id)) {
        libellesParEtude.set(e.id, e.studyDescription || "");
      }
    }
    for (const s of seriesRows) {
      const sid = (s as any).studyId as number;
      const morceaux = [(s as any).seriesDescription, (s as any).bodyPart]
        .filter(Boolean)
        .join(" ");
      if (morceaux) {
        libellesParEtude.set(
          sid,
          `${libellesParEtude.get(sid) || ""} ${morceaux}`
        );
      }
    }
    for (const e of parExamen) {
      if (!e.studyIds.length) continue;
      e.studyIds = filtrerParAnatomie(
        e.exam.description || "",
        e.studyIds.map(id => ({
          studyId: id,
          libelles: libellesParEtude.get(id) || "",
        }))
      );
    }
  }

  return {
    tousTrouves: parExamen.every(e => e.studyIds.length > 0),
    datesExactes: parExamen.every(e => e.dateExacte && e.studyIds.length > 0),
    parExamen,
  };
}
