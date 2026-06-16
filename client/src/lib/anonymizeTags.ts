/**
 * Plan d'anonymisation des tags DICOM (menu « Anonymize… »).
 *
 * Inspiré du profil de base de la PS3.15 « Basic Application Confidentiality
 * Profile » (DICOM Supplement 142) : on retire/neutralise les attributs
 * porteurs d'identité (PHI) tout en conservant ce qui est nécessaire à la
 * lecture clinique de l'image (modalité, géométrie, paramètres d'acquisition…).
 *
 * Fonctions PURES et déterministes : aucune dépendance React / DOM / Cornerstone
 * et aucune I/O. On manipule uniquement un dictionnaire `Record<tag, value>` où
 * la clé est un tag normalisé `xGGGGEEEE` (minuscules, comme dicom-parser) ou la
 * forme `(GGGG,EEEE)` — voir `normalizeTagKey`.
 *
 * NB : ce module agit sur les MÉTADONNÉES (en-tête). Le PHI « brûlé » dans les
 * pixels relève du module `redaction.ts`.
 */

/** Action d'anonymisation appliquée à un tag. */
export type AnonymizationAction =
  /** Supprime l'attribut du dataset (clé retirée). */
  | "remove"
  /** Vide la valeur (chaîne vide) en conservant la clé (action « Z » DICOM). */
  | "blank"
  /** Remplace par une valeur fixe `replacement` (action « D » DICOM). */
  | "replace"
  /** Conserve la valeur telle quelle (utile pour surcharger une règle large). */
  | "keep";

/** Une règle d'anonymisation pour un tag donné. */
export interface AnonymizationRule {
  /** Tag normalisé `xGGGGEEEE` (minuscules). */
  tag: string;
  /** Nom lisible (diagnostic / UI). */
  name: string;
  /** Action à appliquer. */
  action: AnonymizationAction;
  /** Valeur de remplacement (requise uniquement pour `replace`). */
  replacement?: string;
}

/** Options du plan d'anonymisation. */
export interface AnonymizationOptions {
  /**
   * Pseudonyme à écrire dans PatientName / PatientID lorsque la règle est
   * `replace`. Défaut « ANONYMOUS » (conforme à l'usage Horos/OsiriX).
   */
  pseudonym?: string;
  /**
   * Si vrai, RETIRE tout tag privé (groupe impair) non couvert par une règle
   * explicite (recommandé : les tags privés peuvent contenir du PHI).
   */
  removePrivateTags?: boolean;
  /**
   * Si vrai, conserve les dates/heures (PatientBirthDate, StudyDate…) au lieu de
   * les vider. Utile quand l'âge/chronologie est cliniquement nécessaire.
   */
  keepDates?: boolean;
  /**
   * Règles supplémentaires (ou surcharges) fournies par l'appelant. Une règle
   * ici l'emporte sur la règle de base portant le même tag.
   */
  extraRules?: readonly AnonymizationRule[];
}

/** Pseudonyme par défaut écrit dans les champs d'identité. */
export const DEFAULT_PSEUDONYM = "ANONYMOUS";

/**
 * Normalise une clé de tag vers la forme `xggggeeee` (préfixe `x`, 8 hex
 * minuscules). Accepte : `x00100010`, `00100010`, `0010,0010`, `(0010,0010)`,
 * `0010 0010`. Renvoie `null` si la clé n'est pas un tag valide.
 */
export function normalizeTagKey(key: string): string | null {
  if (typeof key !== "string") return null;
  // On retire le préfixe x, parenthèses, virgules, espaces, tirets.
  const hex = key
    .trim()
    .toLowerCase()
    .replace(/^x/, "")
    .replace(/[(),\s_-]/g, "");
  if (!/^[0-9a-f]{8}$/.test(hex)) return null;
  return "x" + hex;
}

/** Vrai si le tag appartient à un groupe PRIVÉ (groupe impair, hors 0001). */
export function isPrivateTag(tag: string): boolean {
  const norm = normalizeTagKey(tag);
  if (!norm) return false;
  const group = parseInt(norm.slice(1, 5), 16);
  // Groupe impair = privé. Le groupe 0000 (command) est exclu, déjà pair.
  return group % 2 === 1;
}

/**
 * Règles de base du plan d'anonymisation. Ordre indicatif. Les tags de dates
 * portent l'action `blank` (vidés) car le profil de base les neutralise ; on
 * peut les conserver via l'option `keepDates`.
 */
export const ANONYMIZATION_RULES: readonly AnonymizationRule[] = [
  // ── Identité patient ─────────────────────────────────────────────────────
  {
    tag: "x00100010",
    name: "PatientName",
    action: "replace",
    replacement: DEFAULT_PSEUDONYM,
  },
  {
    tag: "x00100020",
    name: "PatientID",
    action: "replace",
    replacement: DEFAULT_PSEUDONYM,
  },
  { tag: "x00100030", name: "PatientBirthDate", action: "blank" },
  { tag: "x00100032", name: "PatientBirthTime", action: "blank" },
  { tag: "x00100040", name: "PatientSex", action: "keep" },
  { tag: "x00101000", name: "OtherPatientIDs", action: "remove" },
  { tag: "x00101001", name: "OtherPatientNames", action: "remove" },
  { tag: "x00101005", name: "PatientBirthName", action: "remove" },
  { tag: "x00101010", name: "PatientAge", action: "keep" },
  { tag: "x00101040", name: "PatientAddress", action: "remove" },
  { tag: "x00102154", name: "PatientTelephoneNumbers", action: "remove" },
  { tag: "x00102160", name: "EthnicGroup", action: "remove" },
  { tag: "x00104000", name: "PatientComments", action: "remove" },
  { tag: "x00102297", name: "ResponsiblePerson", action: "remove" },
  { tag: "x00102299", name: "ResponsibleOrganization", action: "remove" },
  { tag: "x00101060", name: "PatientMotherBirthName", action: "remove" },

  // ── Médecins / établissement ─────────────────────────────────────────────
  { tag: "x00080080", name: "InstitutionName", action: "remove" },
  { tag: "x00080081", name: "InstitutionAddress", action: "remove" },
  { tag: "x00081040", name: "InstitutionalDepartmentName", action: "remove" },
  { tag: "x00080090", name: "ReferringPhysicianName", action: "blank" },
  { tag: "x00080092", name: "ReferringPhysicianAddress", action: "remove" },
  {
    tag: "x00080094",
    name: "ReferringPhysicianTelephoneNumbers",
    action: "remove",
  },
  { tag: "x00081048", name: "PhysiciansOfRecord", action: "remove" },
  { tag: "x00081050", name: "PerformingPhysicianName", action: "remove" },
  { tag: "x00081060", name: "NameOfPhysiciansReadingStudy", action: "remove" },
  { tag: "x00081070", name: "OperatorsName", action: "remove" },
  { tag: "x00081010", name: "StationName", action: "remove" },
  { tag: "x00181000", name: "DeviceSerialNumber", action: "remove" },

  // ── Identifiants d'étude / accession ─────────────────────────────────────
  { tag: "x00080050", name: "AccessionNumber", action: "blank" },
  { tag: "x00200010", name: "StudyID", action: "blank" },
  { tag: "x00081030", name: "StudyDescription", action: "keep" },
  { tag: "x0008103e", name: "SeriesDescription", action: "keep" },
  { tag: "x00080021", name: "SeriesDate", action: "blank" },
  { tag: "x00080031", name: "SeriesTime", action: "keep" },

  // ── Dates / heures ───────────────────────────────────────────────────────
  { tag: "x00080020", name: "StudyDate", action: "blank" },
  { tag: "x00080030", name: "StudyTime", action: "keep" },
  { tag: "x00080022", name: "AcquisitionDate", action: "blank" },
  { tag: "x00080023", name: "ContentDate", action: "blank" },
  { tag: "x00080012", name: "InstanceCreationDate", action: "blank" },
  { tag: "x00080013", name: "InstanceCreationTime", action: "keep" },

  // ── UIDs (identifiants uniques susceptibles de réidentifier) ─────────────
  {
    tag: "x0020000d",
    name: "StudyInstanceUID",
    action: "replace",
    replacement: "",
  },
  {
    tag: "x0020000e",
    name: "SeriesInstanceUID",
    action: "replace",
    replacement: "",
  },
  {
    tag: "x00080018",
    name: "SOPInstanceUID",
    action: "replace",
    replacement: "",
  },
  { tag: "x00080016", name: "SOPClassUID", action: "keep" },
  {
    tag: "x00020003",
    name: "MediaStorageSOPInstanceUID",
    action: "replace",
    replacement: "",
  },
  {
    tag: "x00200052",
    name: "FrameOfReferenceUID",
    action: "replace",
    replacement: "",
  },
  { tag: "x00880140", name: "StorageMediaFileSetUID", action: "remove" },

  // ── Divers PHI ───────────────────────────────────────────────────────────
  { tag: "x00081080", name: "AdmittingDiagnosesDescription", action: "remove" },
  { tag: "x00102180", name: "Occupation", action: "remove" },
  { tag: "x001021b0", name: "AdditionalPatientHistory", action: "remove" },
  { tag: "x00380010", name: "AdmissionID", action: "remove" },
  { tag: "x00380400", name: "PatientInstitutionResidence", action: "remove" },
  { tag: "x00400241", name: "PerformedStationAETitle", action: "remove" },
  { tag: "x00321032", name: "RequestingPhysician", action: "remove" },
  { tag: "x00321060", name: "RequestedProcedureDescription", action: "keep" },
];

/** Tags de dates/heures neutralisés par défaut (pour l'option `keepDates`). */
const DATE_TIME_TAGS = new Set<string>([
  "x00100030", // PatientBirthDate
  "x00100032", // PatientBirthTime
  "x00080020", // StudyDate
  "x00080021", // SeriesDate
  "x00080022", // AcquisitionDate
  "x00080023", // ContentDate
  "x00080012", // InstanceCreationDate
]);

/**
 * Construit la table effective tag → règle, en appliquant les options :
 *   • surcharges `extraRules` (l'emportent sur les règles de base) ;
 *   • `pseudonym` injecté dans les règles `replace` portant le pseudonyme
 *     par défaut (identité patient) ;
 *   • `keepDates` transforme les règles de dates en `keep`.
 * Les UIDs (`replace` avec `replacement === ""`) ne sont PAS touchés par le
 * pseudonyme.
 */
export function buildRuleTable(
  options: AnonymizationOptions = {}
): Map<string, AnonymizationRule> {
  const pseudonym = options.pseudonym ?? DEFAULT_PSEUDONYM;
  const table = new Map<string, AnonymizationRule>();

  for (const rule of ANONYMIZATION_RULES) {
    let effective: AnonymizationRule = { ...rule };

    // Pseudonyme d'identité : on ne remplace que les règles dont le
    // remplacement par défaut EST le pseudonyme par défaut (PatientName/ID).
    if (
      effective.action === "replace" &&
      effective.replacement === DEFAULT_PSEUDONYM
    ) {
      effective = { ...effective, replacement: pseudonym };
    }

    // Conserver les dates si demandé.
    if (options.keepDates && DATE_TIME_TAGS.has(effective.tag)) {
      effective = { ...effective, action: "keep" };
    }

    table.set(effective.tag, effective);
  }

  // Surcharges appelant : normalisées et prioritaires.
  for (const extra of options.extraRules ?? []) {
    const norm = normalizeTagKey(extra.tag);
    if (!norm) continue;
    table.set(norm, { ...extra, tag: norm });
  }

  return table;
}

/**
 * Applique une règle à une valeur et renvoie le résultat :
 *   • `{ keep: true }`            → laisser la valeur telle quelle ;
 *   • `{ remove: true }`          → retirer la clé du dataset ;
 *   • `{ value: string }`         → écrire cette valeur (blank ⇒ "").
 */
function applyRule(
  rule: AnonymizationRule
): { keep: true } | { remove: true } | { value: string } {
  switch (rule.action) {
    case "keep":
      return { keep: true };
    case "remove":
      return { remove: true };
    case "blank":
      return { value: "" };
    case "replace":
      return { value: rule.replacement ?? "" };
    default:
      // Sécurité : action inconnue → on retire (fail-closed côté PHI).
      return { remove: true };
  }
}

/**
 * Applique le plan d'anonymisation à un dictionnaire de tags et renvoie un
 * NOUVEL objet (la source n'est pas mutée). PUR : même entrée → même sortie.
 *
 * Comportement :
 *   • chaque clé est normalisée (`xggggeeee`) ; une clé non parsable est
 *     conservée telle quelle, sans modification ;
 *   • une règle `remove` retire la clé ; `blank`/`replace` écrivent une valeur ;
 *     `keep` laisse la valeur inchangée ;
 *   • un tag sans règle est conservé, SAUF s'il est privé et que
 *     `removePrivateTags` est vrai (alors il est retiré).
 */
export function applyAnonymizationPlan(
  tags: Record<string, string>,
  options: AnonymizationOptions = {}
): Record<string, string> {
  const table = buildRuleTable(options);
  const out: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(tags)) {
    const norm = normalizeTagKey(rawKey);

    // Clé non reconnue comme tag : on la conserve inchangée.
    if (!norm) {
      out[rawKey] = value;
      continue;
    }

    const rule = table.get(norm);
    if (rule) {
      const res = applyRule(rule);
      if ("remove" in res) continue;
      if ("keep" in res) {
        out[norm] = value;
        continue;
      }
      out[norm] = res.value;
      continue;
    }

    // Pas de règle explicite.
    if (options.removePrivateTags && isPrivateTag(norm)) {
      continue; // tag privé non couvert → retiré
    }
    out[norm] = value;
  }

  return out;
}
