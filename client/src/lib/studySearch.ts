// Recherche multi-champs du navigateur d'études (champ « Search » de Horos).
//
// Reproduit le comportement du champ de recherche du navigateur de base Horos :
// l'utilisateur tape une requête libre, et la liste des études se filtre sur
// PLUSIEURS champs à la fois (nom du patient, ID, description, modalité, date,
// référent, etc.). La recherche est insensible à la casse ET aux accents
// (« müller » trouve « MULLER », « echo » trouve « Écho »), et chaque mot de la
// requête doit être présent dans AU MOINS un des champs retenus (ET sur les
// mots, OU sur les champs) — comportement attendu d'une recherche d'inventaire.
//
// Fonctions 100 % PURES et déterministes : aucune dépendance React / DOM /
// Cornerstone / I/O. On ne manipule que des objets « étude » génériques et des
// chaînes. Testable hors navigateur.

/**
 * Étude au sens du navigateur : un sac de champs hétérogènes. On reste
 * volontairement permissif sur les types des valeurs (chaîne, nombre, date,
 * absent) car les champs proviennent de tags DICOM bruts hétérogènes. La
 * normalisation se charge de tout aplatir en texte cherchable.
 */
export type StudyRecord = Record<string, unknown>;

/**
 * Normalise une chaîne pour comparaison : minuscules + suppression des accents
 * (décomposition NFD puis retrait des diacritiques) + espaces compactés. C'est
 * le cœur de l'insensibilité casse/accents. Une entrée non-chaîne est d'abord
 * convertie via `String(...)`.
 */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return (
    String(value)
      .normalize("NFD")
      // Retrait des marques diacritiques combinantes (accents) — plage U+0300..U+036F.
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Découpe une requête en jetons (mots) normalisés, séparés par les blancs.
 * Renvoie un tableau éventuellement vide (requête vide / blancs uniquement).
 */
export function tokenize(query: string): string[] {
  const norm = normalizeText(query);
  if (!norm) return [];
  return norm.split(" ").filter(t => t.length > 0);
}

/**
 * Concatène les valeurs des `fields` d'une étude en une seule chaîne normalisée
 * (les champs absents sont ignorés). Sert de « texte cherchable » de l'étude.
 * Les valeurs sont jointes par un espace pour éviter qu'un mot d'un champ ne se
 * colle au mot d'un autre champ (faux positifs).
 */
function searchableText(study: StudyRecord, fields: readonly string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = study?.[f];
    if (v === null || v === undefined) continue;
    const n = normalizeText(v);
    if (n) parts.push(n);
  }
  return parts.join(" ");
}

/**
 * Construit un prédicat de correspondance pour une requête et une liste de
 * champs donnés. Le prédicat renvoie `true` si CHAQUE mot de la requête (après
 * normalisation) est présent en sous-chaîne dans le texte cherchable de l'étude
 * (concaténation des champs). Une requête vide accepte toutes les études.
 *
 * Le prédicat est PUR et capture la requête/les champs (mémoïsation des jetons
 * faite une seule fois à la construction → efficace pour filtrer N études).
 */
export function buildSearchMatcher(
  query: string,
  fields: string[]
): (study: StudyRecord) => boolean {
  const tokens = tokenize(query);
  const safeFields = Array.isArray(fields) ? fields : [];
  // Requête vide → tout passe.
  if (tokens.length === 0) {
    return () => true;
  }
  return (study: StudyRecord): boolean => {
    if (study === null || study === undefined) return false;
    const hay = searchableText(study, safeFields);
    if (!hay) return false;
    return tokens.every(t => hay.includes(t));
  };
}

/**
 * Variante « tous les champs de l'étude » : applique la recherche sur l'ENSEMBLE
 * des valeurs de l'objet étude (toutes ses clés), sans avoir à énumérer les
 * champs. Pratique quand on veut « chercher partout ». Insensible casse/accents,
 * ET sur les mots. Requête vide → `true`.
 */
export function matchAllFields(study: StudyRecord, query: string): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  if (study === null || study === undefined) return false;
  const fields = Object.keys(study);
  const hay = searchableText(study, fields);
  if (!hay) return false;
  return tokens.every(t => hay.includes(t));
}

/**
 * Filtre une liste d'études par modalité (tag Modality, ex. « CT », « MR »,
 * « PT »). La comparaison est normalisée (casse/accents) et exacte sur la
 * valeur du champ `modality`. Une modalité vide/absente renvoie la liste
 * inchangée (pas de filtre). Le champ source par défaut est `modality` mais
 * peut être surchargé (certaines listes exposent `modalitiesInStudy`).
 *
 * PUR : renvoie un NOUVEAU tableau, n'altère pas l'entrée.
 */
export function filterByModality(
  studies: readonly StudyRecord[],
  modality: string,
  field = "modality"
): StudyRecord[] {
  const list = Array.isArray(studies) ? studies : [];
  const target = normalizeText(modality);
  if (!target) return list.slice();
  return list.filter(s => {
    if (s === null || s === undefined) return false;
    const raw = s[field];
    if (raw === null || raw === undefined) return false;
    // Une étude peut lister plusieurs modalités séparées par \, , / ou espace
    // (ex. « CT\PT »). On découpe et on cherche une correspondance exacte.
    const tokens = normalizeText(raw)
      .split(/[\\,/ ]+/)
      .filter(Boolean);
    return tokens.includes(target);
  });
}

/**
 * Parse une date DICOM DA `YYYYMMDD` (les `-` / `/` éventuels sont tolérés) en
 * un entier comparable `YYYYMMDD`. Renvoie `null` si le format est inexploitable
 * ou si la date est hors borne (mois 1..12, jour 1..31). On reste lexicographique
 * (entier AAAAMMJJ) : pas de fuseau, comparaison sûre et déterministe.
 */
export function parseDicomDate(da: unknown): number | null {
  if (da === null || da === undefined) return null;
  const raw = String(da).trim().replace(/[-/.]/g, "");
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}

/**
 * Filtre une liste d'études par plage de dates [from, to] INCLUSIVE, sur le tag
 * StudyDate (`studyDate` par défaut, format DICOM DA `YYYYMMDD`). `from` et `to`
 * sont eux aussi des dates DICOM DA (ou `null`/`""` pour borne ouverte).
 *
 * Règles :
 *   • from absent → pas de borne basse ; to absent → pas de borne haute.
 *   • from & to absents → liste inchangée.
 *   • from > to (inversé) → bornes ré-ordonnées (tolérance ergonomique).
 *   • étude sans date parsable → EXCLUE dès qu'au moins une borne est posée.
 *
 * PUR : renvoie un NOUVEAU tableau.
 */
export function filterByDateRange(
  studies: readonly StudyRecord[],
  from: string | null | undefined,
  to: string | null | undefined,
  field = "studyDate"
): StudyRecord[] {
  const list = Array.isArray(studies) ? studies : [];
  let lo = parseDicomDate(from ?? "");
  let hi = parseDicomDate(to ?? "");
  // Aucune borne valide → pas de filtre.
  if (lo === null && hi === null) return list.slice();
  // Bornes inversées → on remet dans l'ordre.
  if (lo !== null && hi !== null && lo > hi) {
    const tmp = lo;
    lo = hi;
    hi = tmp;
  }
  return list.filter(s => {
    if (s === null || s === undefined) return false;
    const d = parseDicomDate(s[field]);
    if (d === null) return false; // date illisible → exclue quand un filtre est posé
    if (lo !== null && d < lo) return false;
    if (hi !== null && d > hi) return false;
    return true;
  });
}
