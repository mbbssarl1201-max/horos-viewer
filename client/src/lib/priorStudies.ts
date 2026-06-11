/**
 * Logique de COMPARATIF / ANTÉRIORITÉS (« prior studies »).
 *
 * Dans un viewer DICOM, ouvrir le dossier d'un patient implique souvent de
 * comparer l'étude courante à ses ANTÉRIORITÉS : examens plus anciens du MÊME
 * patient (un scanner thoracique d'aujourd'hui vs celui d'il y a six mois,
 * etc.). Ce module fournit la logique de sélection/tri PURE :
 *
 *   • `findPriors(current, allStudies)` — les études du même PatientID, hors
 *     l'étude courante, triées par date d'étude DÉCROISSANTE (plus récente
 *     d'abord) ; départage stable par heure puis par UID.
 *   • `groupByModality(priors)` — regroupe une liste d'études par modalité
 *     normalisée (CT, MR, PT…), pratique pour proposer « le CT précédent ».
 *   • `mostRecentPrior(current, all, modality?)` — raccourci : l'antériorité la
 *     plus récente, éventuellement filtrée sur une modalité.
 *
 * Module 100 % PUR et déterministe : aucune dépendance React / DOM /
 * Cornerstone / I/O. On ne manipule que des objets de métadonnées déjà extraits.
 *
 * ── Identité patient ────────────────────────────────────────────────────────
 * On rapproche les études par `patientId` (PatientID, 0010,0020) NORMALISÉ
 * (trim, comparaison sensible à la casse car un PatientID est un identifiant
 * technique, pas un libellé). Un patientId vide/absent ne rapproche personne :
 * deux études sans PatientID ne sont JAMAIS considérées comme le même patient
 * (choix de sûreté — on ne mélange pas des dossiers anonymes par accident).
 *
 * ── Dates ───────────────────────────────────────────────────────────────────
 * `studyDate` est au format DICOM DA `YYYYMMDD` (les `-`/`/` éventuels sont
 * tolérés) et `studyTime` au format TM `HHMMSS(.ffffff)`. Une date absente /
 * non parsable est traitée comme « la plus ancienne possible » pour le tri, de
 * sorte qu'une antériorité datée passe toujours AVANT une non datée.
 */

/** Identité d'étude minimale nécessaire au calcul des antériorités. */
export interface StudySummary {
  /** StudyInstanceUID (0020,000D) — identifiant unique de l'étude. */
  studyInstanceUid: string;
  /** PatientID (0010,0020) — identifiant technique du patient. */
  patientId?: string | null;
  /** Date d'étude (StudyDate, 0008,0020), format DICOM DA `YYYYMMDD`. */
  studyDate?: string | null;
  /** Heure d'étude (StudyTime, 0008,0030), format DICOM TM `HHMMSS(.ffffff)`. */
  studyTime?: string | null;
  /** Modalité dominante de l'étude (Modality, 0008,0060). */
  modality?: string | null;
  /** Description d'étude (StudyDescription, 0008,1030), purement informatif. */
  studyDescription?: string | null;
}

/** Normalise un PatientID : trim, `null`/`undefined` → "". Casse conservée. */
function normalizePatientId(id: unknown): string {
  if (id === null || id === undefined) return "";
  return String(id).trim();
}

/** Normalise une modalité : trim + MAJUSCULES, `null`/absent → "". */
export function normalizeModality(modality: unknown): string {
  if (modality === null || modality === undefined) return "";
  return String(modality).trim().toUpperCase();
}

/**
 * Convertit une date+heure DICOM en un entier ordonnable (clé de tri). On
 * encode `YYYYMMDD` × 1e6 + `HHMMSS` afin qu'une comparaison numérique simple
 * reflète l'ordre chronologique. Renvoie `null` si la DATE est inexploitable
 * (une heure absente ne pénalise pas : on prend 000000).
 *
 * Tolérant : les séparateurs `-` `/` `:` `.`/espaces sont retirés ; on exige au
 * moins `YYYYMMDD` (8 chiffres) pour la date. Les bornes mois/jour/heure sont
 * validées (date aberrante → `null`).
 */
export function studyChronoKey(
  studyDate: unknown,
  studyTime?: unknown
): number | null {
  if (studyDate === null || studyDate === undefined) return null;
  const d = String(studyDate).replace(/[-/.\s]/g, "");
  const md = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  if (!md) return null;
  const year = parseInt(md[1], 10);
  const month = parseInt(md[2], 10);
  const day = parseInt(md[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Heure optionnelle : on tolère HH / HHMM / HHMMSS(.ffffff).
  let hh = 0;
  let mm = 0;
  let ss = 0;
  if (studyTime !== null && studyTime !== undefined) {
    const t = String(studyTime).replace(/[:\s]/g, "");
    const mt = /^(\d{2})(\d{2})?(\d{2})?(?:\.\d+)?$/.exec(t);
    if (mt) {
      const h = parseInt(mt[1], 10);
      const m = mt[2] !== undefined ? parseInt(mt[2], 10) : 0;
      const s = mt[3] !== undefined ? parseInt(mt[3], 10) : 0;
      // Heure aberrante → ignorée (on garde 000000), la date prime.
      if (h <= 23 && m <= 59 && s <= 60) {
        hh = h;
        mm = m;
        ss = s;
      }
    }
  }

  const datePart = year * 10000 + month * 100 + day; // YYYYMMDD
  const timePart = hh * 10000 + mm * 100 + ss; // HHMMSS
  return datePart * 1_000_000 + timePart;
}

/**
 * Compare deux études pour un tri par date DÉCROISSANTE (plus récente d'abord).
 * Départage déterministe et stable : à date+heure égales, on ordonne par UID
 * (ordre lexicographique croissant) afin d'éviter toute ambiguïté de tri. Une
 * étude sans date valide est considérée comme la plus ANCIENNE (passe après).
 */
function compareByDateDesc(a: StudySummary, b: StudySummary): number {
  const ka = studyChronoKey(a.studyDate, a.studyTime);
  const kb = studyChronoKey(b.studyDate, b.studyTime);
  // Les non-datées (null) en dernier, quel que soit le sens.
  if (ka === null && kb === null) {
    return a.studyInstanceUid < b.studyInstanceUid
      ? -1
      : a.studyInstanceUid > b.studyInstanceUid
        ? 1
        : 0;
  }
  if (ka === null) return 1;
  if (kb === null) return -1;
  if (ka !== kb) return kb - ka; // décroissant
  // Date+heure identiques → départage stable par UID.
  return a.studyInstanceUid < b.studyInstanceUid
    ? -1
    : a.studyInstanceUid > b.studyInstanceUid
      ? 1
      : 0;
}

/**
 * Renvoie les ANTÉRIORITÉS de l'étude courante : toutes les études de
 * `allStudies` qui appartiennent au MÊME patient (PatientID identique, non
 * vide) et qui ne sont PAS l'étude courante (même StudyInstanceUID exclu),
 * triées par date d'étude décroissante (plus récente d'abord).
 *
 * Robustesse :
 *   • `allStudies` `null`/`undefined` ou vide → `[]`.
 *   • `current` sans PatientID exploitable → `[]` (on ne rapproche personne).
 *   • l'étude courante est toujours retirée (par UID), même si elle est dupliquée.
 *   • aucune mutation de l'entrée : on renvoie un NOUVEAU tableau.
 */
export function findPriors(
  current: StudySummary,
  allStudies: readonly StudySummary[] | null | undefined
): StudySummary[] {
  if (!allStudies || allStudies.length === 0) return [];
  const pid = normalizePatientId(current.patientId);
  if (pid === "") return [];
  const currentUid = current.studyInstanceUid;

  const priors = allStudies.filter(
    s =>
      normalizePatientId(s.patientId) === pid &&
      s.studyInstanceUid !== currentUid
  );
  // Copie défensive avant tri (filter renvoie déjà un nouveau tableau, mais on
  // garantit l'absence d'effet de bord même si l'appelant réutilise la sortie).
  return priors.slice().sort(compareByDateDesc);
}

/**
 * Regroupe des études par MODALITÉ normalisée (CT, MR, PT…). Une modalité
 * absente/vide est rangée sous la clé "" (chaîne vide). L'ordre des études à
 * l'intérieur de chaque groupe est PRÉSERVÉ (donc déjà trié si l'entrée l'était,
 * p. ex. la sortie de `findPriors`). Renvoie une `Map` (ordre d'insertion des
 * clés = ordre de première apparition).
 */
export function groupByModality(
  priors: readonly StudySummary[] | null | undefined
): Map<string, StudySummary[]> {
  const out = new Map<string, StudySummary[]>();
  if (!priors) return out;
  for (const s of priors) {
    const key = normalizeModality(s.modality);
    const bucket = out.get(key);
    if (bucket) bucket.push(s);
    else out.set(key, [s]);
  }
  return out;
}

/**
 * L'antériorité la PLUS RÉCENTE de l'étude courante, ou `null` s'il n'y en a
 * aucune. Si `modality` est fournie (non vide), on ne considère que les
 * antériorités de cette modalité (comparaison normalisée). Une `modality`
 * absente / vide → toutes modalités confondues.
 */
export function mostRecentPrior(
  current: StudySummary,
  allStudies: readonly StudySummary[] | null | undefined,
  modality?: string | null
): StudySummary | null {
  const priors = findPriors(current, allStudies);
  const wanted = normalizeModality(modality);
  const candidates =
    wanted === ""
      ? priors
      : priors.filter(s => normalizeModality(s.modality) === wanted);
  // `priors` est déjà trié par date décroissante → le premier est le plus récent.
  return candidates.length > 0 ? candidates[0] : null;
}
