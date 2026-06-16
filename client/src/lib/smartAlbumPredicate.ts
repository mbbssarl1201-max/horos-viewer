// Modèle et évaluateur de PRÉDICATS pour les « Smart Albums » (menu « Add a
// smart album », recopie d'Horos). Un smart album est un filtre déclaratif :
// un groupe de prédicats (champ / opérateur / valeur) combinés en ET / OU, que
// l'on évalue contre chaque étude pour décider si elle entre dans l'album.
//
// Code 100 % PUR et déterministe : aucune dépendance DOM / Cornerstone / I/O.
// On ne manipule que des objets simples → testable hors navigateur.
//
// Choix de robustesse : un prédicat mal formé, une valeur absente ou un type
// incohérent rendent `false` (l'étude n'entre pas), JAMAIS d'exception. Mieux
// vaut un album vide qu'un crash de l'UI.

/** Champs d'une étude sur lesquels un prédicat peut porter. */
export type PredicateField =
  | "patientName"
  | "patientID"
  | "modality"
  | "studyDate"
  | "seriesCount"
  | "accession"
  | "institution";

/** Opérateurs disponibles selon le type du champ. */
export type PredicateOp =
  | "contains" // sous-chaîne, insensible à la casse (champs texte)
  | "equals" // égalité (texte insensible casse, ou nombre)
  | "before" // date < valeur (champ studyDate)
  | "after" // date > valeur (champ studyDate)
  | "gt" // strictement supérieur (nombre, ex. seriesCount)
  | "lt" // strictement inférieur (nombre)
  | "between"; // intervalle inclusif [a, b] (date ou nombre)

/**
 * Un prédicat élémentaire. `value` est :
 *   • une chaîne pour contains/equals (texte) ou une date `YYYYMMDD`/`YYYY-MM-DD` ;
 *   • un nombre pour equals/gt/lt sur un champ numérique ;
 *   • un couple `[a, b]` pour `between` (dates ou nombres selon le champ).
 */
export interface Predicate {
  field: PredicateField;
  op: PredicateOp;
  value: string | number | [string | number, string | number];
}

/** Logique de combinaison d'un groupe de prédicats. */
export type GroupLogic = "AND" | "OR";

/** Groupe de prédicats combinés par une logique ET/OU. */
export interface PredicateGroup {
  logic: GroupLogic;
  predicates: Predicate[];
}

/**
 * Vue minimale d'une étude exploitable par les prédicats. Tous les champs sont
 * optionnels : une étude réelle peut manquer un tag. Un champ absent fait
 * échouer le prédicat qui le cible (résultat `false`).
 */
export interface StudyLike {
  patientName?: string | null;
  patientID?: string | null;
  /** Modalité(s) de l'étude : « CT », ou liste « CT\\MR », ou tableau. */
  modality?: string | string[] | null;
  /** Date d'étude, format DICOM `YYYYMMDD` ou ISO `YYYY-MM-DD`. */
  studyDate?: string | null;
  /** Nombre de séries de l'étude. */
  seriesCount?: number | null;
  accession?: string | null;
  institution?: string | null;
}

/** Ensemble des champs de type texte (le reste étant numérique/date). */
const TEXT_FIELDS = new Set<PredicateField>([
  "patientName",
  "patientID",
  "modality",
  "accession",
  "institution",
]);

/** Convertit une valeur inconnue en nombre fini, ou `null`. */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Normalise une chaîne pour comparaison texte (trim + minuscules). */
function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return String(v).toLowerCase();
  if (typeof v !== "string") return null;
  return v.trim().toLowerCase();
}

/**
 * Parse une date d'étude (`YYYYMMDD` DICOM ou `YYYY-MM-DD` ISO, séparateurs
 * `/` ou `.` tolérés) en entier comparable `YYYYMMDD`. Renvoie `null` si la
 * date est inexploitable ou hors borne calendaire simple.
 */
export function parseStudyDate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    // Déjà un entier YYYYMMDD ?
    return Number.isInteger(v) && v >= 10000101 && v <= 99991231 ? v : null;
  }
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw) return null;
  const digits = raw.replace(/[-/.]/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = parseInt(digits.slice(0, 4), 10);
  const month = parseInt(digits.slice(4, 6), 10);
  const day = parseInt(digits.slice(6, 8), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}

/**
 * Récupère, pour un champ texte, la liste des valeurs candidates de l'étude.
 * La modalité peut être multiple (« CT\\MR » ou tableau) ; pour les autres
 * champs il n'y a qu'une valeur. Renvoie `[]` si le champ est absent.
 */
function textCandidates(study: StudyLike, field: PredicateField): string[] {
  if (field === "modality") {
    const m = study.modality;
    if (m === null || m === undefined) return [];
    const parts = Array.isArray(m) ? m : String(m).split("\\");
    const out: string[] = [];
    for (const p of parts) {
      const n = normText(p);
      if (n !== null && n !== "") out.push(n);
    }
    return out;
  }
  const raw =
    field === "patientName"
      ? study.patientName
      : field === "patientID"
        ? study.patientID
        : field === "accession"
          ? study.accession
          : field === "institution"
            ? study.institution
            : null;
  const n = normText(raw);
  return n === null || n === "" ? [] : [n];
}

/** Extrait le couple `[a, b]` d'un `between`, ou `null` si la valeur est mal formée. */
function asPair(
  value: Predicate["value"]
): [string | number, string | number] | null {
  if (Array.isArray(value) && value.length === 2) {
    return [value[0], value[1]];
  }
  return null;
}

/** Évalue un prédicat sur un champ TEXTE (contains / equals). */
function evalText(study: StudyLike, p: Predicate): boolean {
  const cands = textCandidates(study, p.field);
  if (cands.length === 0) return false; // champ absent → échec
  const needle = normText(Array.isArray(p.value) ? undefined : p.value);
  if (needle === null || needle === "") return false;
  switch (p.op) {
    case "contains":
      return cands.some(c => c.includes(needle));
    case "equals":
      return cands.some(c => c === needle);
    default:
      // Opérateur incompatible avec un champ texte.
      return false;
  }
}

/** Évalue un prédicat sur le champ DATE `studyDate`. */
function evalDate(study: StudyLike, p: Predicate): boolean {
  const d = parseStudyDate(study.studyDate);
  if (d === null) return false; // date d'étude absente / invalide → échec
  switch (p.op) {
    case "equals": {
      const v = parseStudyDate(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && d === v;
    }
    case "before": {
      const v = parseStudyDate(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && d < v;
    }
    case "after": {
      const v = parseStudyDate(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && d > v;
    }
    case "between": {
      const pair = asPair(p.value);
      if (!pair) return false;
      const a = parseStudyDate(pair[0]);
      const b = parseStudyDate(pair[1]);
      if (a === null || b === null) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return d >= lo && d <= hi;
    }
    default:
      // contains / gt / lt n'ont pas de sens pour une date.
      return false;
  }
}

/** Évalue un prédicat sur le champ NUMÉRIQUE `seriesCount`. */
function evalNumber(study: StudyLike, p: Predicate): boolean {
  const n = toFiniteNumber(study.seriesCount);
  if (n === null) return false; // valeur absente / non numérique → échec
  switch (p.op) {
    case "equals": {
      const v = toFiniteNumber(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && n === v;
    }
    case "gt": {
      const v = toFiniteNumber(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && n > v;
    }
    case "lt": {
      const v = toFiniteNumber(Array.isArray(p.value) ? undefined : p.value);
      return v !== null && n < v;
    }
    case "between": {
      const pair = asPair(p.value);
      if (!pair) return false;
      const a = toFiniteNumber(pair[0]);
      const b = toFiniteNumber(pair[1]);
      if (a === null || b === null) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return n >= lo && n <= hi;
    }
    default:
      // contains / before / after n'ont pas de sens pour un nombre.
      return false;
  }
}

/**
 * Évalue UN prédicat sur une étude. Renvoie `true` si l'étude le satisfait.
 * Tout cas indéterminé (champ absent, opérateur incompatible, valeur mal
 * formée, prédicat null) rend `false` — jamais d'exception.
 */
export function evaluatePredicate(
  study: StudyLike | null | undefined,
  predicate: Predicate | null | undefined
): boolean {
  if (!study || !predicate) return false;
  const { field } = predicate;
  if (TEXT_FIELDS.has(field)) return evalText(study, predicate);
  if (field === "studyDate") return evalDate(study, predicate);
  if (field === "seriesCount") return evalNumber(study, predicate);
  return false; // champ inconnu
}

/**
 * Évalue un GROUPE de prédicats combinés en ET / OU.
 *
 * Conventions (alignées sur le comportement intuitif des smart albums) :
 *   • AND avec un groupe vide → `true` (aucune contrainte = tout passe).
 *   • OR  avec un groupe vide → `false` (aucune condition satisfaite).
 *   • un groupe / une étude null → `false`.
 */
export function evaluateGroup(
  study: StudyLike | null | undefined,
  group: PredicateGroup | null | undefined
): boolean {
  if (!study || !group || !Array.isArray(group.predicates)) return false;
  const preds = group.predicates;
  if (group.logic === "AND") {
    return preds.every(p => evaluatePredicate(study, p));
  }
  if (group.logic === "OR") {
    return preds.some(p => evaluatePredicate(study, p));
  }
  return false; // logique inconnue
}
