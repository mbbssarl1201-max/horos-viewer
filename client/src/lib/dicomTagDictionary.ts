/**
 * Dictionnaire de tags DICOM + formatage pour l'inspecteur « DICOM Meta-Data ».
 *
 * Sert au volet d'inspection des métadonnées : on liste les tags présents dans
 * un dataset, on les nomme lisiblement (Patient Name, Study Date, …) et on
 * formate leur valeur brute selon le VR (Value Representation) DICOM.
 *
 * Fonctions PURES et déterministes : aucune dépendance React / DOM / Cornerstone
 * / dicom-parser. On ne manipule que des chaînes et des structures simples, donc
 * testable hors navigateur.
 *
 * ── Format des clés ──────────────────────────────────────────────────────────
 * Les clés du dictionnaire sont au format canonique « GGGG,EEEE » : groupe et
 * élément en hexadécimal MAJUSCULE sur 4 chiffres, séparés par une virgule
 * (ex. « 0010,0010 » pour PatientName). `normalizeTag` accepte les variantes
 * courantes (préfixe `x`, parenthèses, espaces, minuscules, sans séparateur).
 *
 * ── Couverture ───────────────────────────────────────────────────────────────
 * ~80 tags les plus courants en imagerie : identité Patient, Study, Series,
 * Image/Acquisition, Equipment, plus quelques tags structurels. Volontairement
 * NON exhaustif (le standard DICOM en compte des milliers) : c'est ce qui est
 * affiché dans l'inspecteur.
 */

/** Description d'un tag DICOM (sans groupe/élément, portés par la clé). */
export interface TagInfo {
  /** Mot-clé DICOM sans espaces (ex. « PatientName »). */
  keyword: string;
  /** Libellé lisible (ex. « Patient's Name »). */
  name: string;
  /** Value Representation DICOM (ex. « PN », « DA », « US »). */
  vr: string;
}

/** Tag résolu : description enrichie du groupe/élément et de la clé canonique. */
export interface ResolvedTag extends TagInfo {
  /** Groupe hexadécimal MAJUSCULE sur 4 chiffres (ex. « 0010 »). */
  group: string;
  /** Élément hexadécimal MAJUSCULE sur 4 chiffres (ex. « 0010 »). */
  element: string;
  /** Clé canonique « GGGG,EEEE ». */
  tag: string;
}

/**
 * Dictionnaire « GGGG,EEEE » → {keyword, name, vr}.
 *
 * VR DICOM principaux rencontrés ici :
 *   PN nom de personne · DA date · TM heure · DT datetime · UI UID ·
 *   IS entier (chaîne) · DS décimal (chaîne) · US/SS entier court (binaire) ·
 *   UL/SL entier long · LO/SH/CS/LT/ST/UT texte · AS âge · SQ séquence.
 */
export const TAG_DICTIONARY: Readonly<Record<string, TagInfo>> = Object.freeze({
  // ── Patient (groupe 0010) ──────────────────────────────────────────────────
  "0010,0010": { keyword: "PatientName", name: "Patient's Name", vr: "PN" },
  "0010,0020": { keyword: "PatientID", name: "Patient ID", vr: "LO" },
  "0010,0030": {
    keyword: "PatientBirthDate",
    name: "Patient's Birth Date",
    vr: "DA",
  },
  "0010,0032": {
    keyword: "PatientBirthTime",
    name: "Patient's Birth Time",
    vr: "TM",
  },
  "0010,0040": { keyword: "PatientSex", name: "Patient's Sex", vr: "CS" },
  "0010,1000": {
    keyword: "OtherPatientIDs",
    name: "Other Patient IDs",
    vr: "LO",
  },
  "0010,1001": {
    keyword: "OtherPatientNames",
    name: "Other Patient Names",
    vr: "PN",
  },
  "0010,1010": { keyword: "PatientAge", name: "Patient's Age", vr: "AS" },
  "0010,1020": { keyword: "PatientSize", name: "Patient's Size", vr: "DS" },
  "0010,1030": { keyword: "PatientWeight", name: "Patient's Weight", vr: "DS" },
  "0010,1040": {
    keyword: "PatientAddress",
    name: "Patient's Address",
    vr: "LO",
  },
  "0010,2160": { keyword: "EthnicGroup", name: "Ethnic Group", vr: "SH" },
  "0010,21B0": {
    keyword: "AdditionalPatientHistory",
    name: "Additional Patient History",
    vr: "LT",
  },
  "0010,4000": {
    keyword: "PatientComments",
    name: "Patient Comments",
    vr: "LT",
  },

  // ── Study (groupes 0008 / 0020 / 0032 / 0038) ──────────────────────────────
  "0008,0020": { keyword: "StudyDate", name: "Study Date", vr: "DA" },
  "0008,0030": { keyword: "StudyTime", name: "Study Time", vr: "TM" },
  "0008,0050": {
    keyword: "AccessionNumber",
    name: "Accession Number",
    vr: "SH",
  },
  "0008,0090": {
    keyword: "ReferringPhysicianName",
    name: "Referring Physician's Name",
    vr: "PN",
  },
  "0008,1030": {
    keyword: "StudyDescription",
    name: "Study Description",
    vr: "LO",
  },
  "0008,1048": {
    keyword: "PhysiciansOfRecord",
    name: "Physician(s) of Record",
    vr: "PN",
  },
  "0008,1060": {
    keyword: "NameOfPhysiciansReadingStudy",
    name: "Name of Physician(s) Reading Study",
    vr: "PN",
  },
  "0020,000D": {
    keyword: "StudyInstanceUID",
    name: "Study Instance UID",
    vr: "UI",
  },
  "0020,0010": { keyword: "StudyID", name: "Study ID", vr: "SH" },
  "0032,1032": {
    keyword: "RequestingPhysician",
    name: "Requesting Physician",
    vr: "PN",
  },
  "0032,1060": {
    keyword: "RequestedProcedureDescription",
    name: "Requested Procedure Description",
    vr: "LO",
  },
  "0038,0010": { keyword: "AdmissionID", name: "Admission ID", vr: "LO" },
  "0038,0050": { keyword: "SpecialNeeds", name: "Special Needs", vr: "LO" },
  "0038,0300": {
    keyword: "CurrentPatientLocation",
    name: "Current Patient Location",
    vr: "LO",
  },

  // ── Series (groupes 0008 / 0018 / 0020 / 0054) ─────────────────────────────
  "0008,0021": { keyword: "SeriesDate", name: "Series Date", vr: "DA" },
  "0008,0031": { keyword: "SeriesTime", name: "Series Time", vr: "TM" },
  "0008,0060": { keyword: "Modality", name: "Modality", vr: "CS" },
  "0008,103E": {
    keyword: "SeriesDescription",
    name: "Series Description",
    vr: "LO",
  },
  "0008,1070": { keyword: "OperatorsName", name: "Operators' Name", vr: "PN" },
  "0018,0015": {
    keyword: "BodyPartExamined",
    name: "Body Part Examined",
    vr: "CS",
  },
  "0018,1030": { keyword: "ProtocolName", name: "Protocol Name", vr: "LO" },
  "0018,5100": {
    keyword: "PatientPosition",
    name: "Patient Position",
    vr: "CS",
  },
  "0020,000E": {
    keyword: "SeriesInstanceUID",
    name: "Series Instance UID",
    vr: "UI",
  },
  "0020,0011": { keyword: "SeriesNumber", name: "Series Number", vr: "IS" },
  "0020,0060": { keyword: "Laterality", name: "Laterality", vr: "CS" },
  "0020,1209": {
    keyword: "NumberOfSeriesRelatedInstances",
    name: "Number of Series Related Instances",
    vr: "IS",
  },
  "0054,1001": { keyword: "Units", name: "Units", vr: "CS" },

  // ── Image / Acquisition (groupes 0008 / 0018 / 0020 / 0028) ────────────────
  "0008,0008": { keyword: "ImageType", name: "Image Type", vr: "CS" },
  "0008,0016": { keyword: "SOPClassUID", name: "SOP Class UID", vr: "UI" },
  "0008,0018": {
    keyword: "SOPInstanceUID",
    name: "SOP Instance UID",
    vr: "UI",
  },
  "0008,0022": {
    keyword: "AcquisitionDate",
    name: "Acquisition Date",
    vr: "DA",
  },
  "0008,0023": { keyword: "ContentDate", name: "Content Date", vr: "DA" },
  "0008,0032": {
    keyword: "AcquisitionTime",
    name: "Acquisition Time",
    vr: "TM",
  },
  "0008,0033": { keyword: "ContentTime", name: "Content Time", vr: "TM" },
  "0018,0050": { keyword: "SliceThickness", name: "Slice Thickness", vr: "DS" },
  "0018,0060": { keyword: "KVP", name: "KVP", vr: "DS" },
  "0018,0080": { keyword: "RepetitionTime", name: "Repetition Time", vr: "DS" },
  "0018,0081": { keyword: "EchoTime", name: "Echo Time", vr: "DS" },
  "0018,0087": {
    keyword: "MagneticFieldStrength",
    name: "Magnetic Field Strength",
    vr: "DS",
  },
  "0018,0088": {
    keyword: "SpacingBetweenSlices",
    name: "Spacing Between Slices",
    vr: "DS",
  },
  "0018,1150": { keyword: "ExposureTime", name: "Exposure Time", vr: "IS" },
  "0018,1151": {
    keyword: "XRayTubeCurrent",
    name: "X-Ray Tube Current",
    vr: "IS",
  },
  "0018,1152": { keyword: "Exposure", name: "Exposure", vr: "IS" },
  "0020,0012": {
    keyword: "AcquisitionNumber",
    name: "Acquisition Number",
    vr: "IS",
  },
  "0020,0013": { keyword: "InstanceNumber", name: "Instance Number", vr: "IS" },
  "0020,0032": {
    keyword: "ImagePositionPatient",
    name: "Image Position (Patient)",
    vr: "DS",
  },
  "0020,0037": {
    keyword: "ImageOrientationPatient",
    name: "Image Orientation (Patient)",
    vr: "DS",
  },
  "0020,0052": {
    keyword: "FrameOfReferenceUID",
    name: "Frame of Reference UID",
    vr: "UI",
  },
  "0020,1041": { keyword: "SliceLocation", name: "Slice Location", vr: "DS" },
  "0028,0002": {
    keyword: "SamplesPerPixel",
    name: "Samples per Pixel",
    vr: "US",
  },
  "0028,0004": {
    keyword: "PhotometricInterpretation",
    name: "Photometric Interpretation",
    vr: "CS",
  },
  "0028,0008": {
    keyword: "NumberOfFrames",
    name: "Number of Frames",
    vr: "IS",
  },
  "0028,0010": { keyword: "Rows", name: "Rows", vr: "US" },
  "0028,0011": { keyword: "Columns", name: "Columns", vr: "US" },
  "0028,0030": { keyword: "PixelSpacing", name: "Pixel Spacing", vr: "DS" },
  "0028,0100": { keyword: "BitsAllocated", name: "Bits Allocated", vr: "US" },
  "0028,0101": { keyword: "BitsStored", name: "Bits Stored", vr: "US" },
  "0028,0102": { keyword: "HighBit", name: "High Bit", vr: "US" },
  "0028,0103": {
    keyword: "PixelRepresentation",
    name: "Pixel Representation",
    vr: "US",
  },
  "0028,1050": { keyword: "WindowCenter", name: "Window Center", vr: "DS" },
  "0028,1051": { keyword: "WindowWidth", name: "Window Width", vr: "DS" },
  "0028,1052": {
    keyword: "RescaleIntercept",
    name: "Rescale Intercept",
    vr: "DS",
  },
  "0028,1053": { keyword: "RescaleSlope", name: "Rescale Slope", vr: "DS" },
  "0028,1054": { keyword: "RescaleType", name: "Rescale Type", vr: "LO" },

  // ── Equipment (groupe 0008 / 0018) ─────────────────────────────────────────
  "0008,0070": { keyword: "Manufacturer", name: "Manufacturer", vr: "LO" },
  "0008,0080": {
    keyword: "InstitutionName",
    name: "Institution Name",
    vr: "LO",
  },
  "0008,0081": {
    keyword: "InstitutionAddress",
    name: "Institution Address",
    vr: "ST",
  },
  "0008,1010": { keyword: "StationName", name: "Station Name", vr: "SH" },
  "0008,1040": {
    keyword: "InstitutionalDepartmentName",
    name: "Institutional Department Name",
    vr: "LO",
  },
  "0008,1090": {
    keyword: "ManufacturerModelName",
    name: "Manufacturer's Model Name",
    vr: "LO",
  },
  "0018,1000": {
    keyword: "DeviceSerialNumber",
    name: "Device Serial Number",
    vr: "LO",
  },
  "0018,1020": {
    keyword: "SoftwareVersions",
    name: "Software Versions",
    vr: "LO",
  },

  // ── Structurels / divers ───────────────────────────────────────────────────
  "0008,0005": {
    keyword: "SpecificCharacterSet",
    name: "Specific Character Set",
    vr: "CS",
  },
  "0008,0012": {
    keyword: "InstanceCreationDate",
    name: "Instance Creation Date",
    vr: "DA",
  },
  "0008,0013": {
    keyword: "InstanceCreationTime",
    name: "Instance Creation Time",
    vr: "TM",
  },
  "0008,0064": { keyword: "ConversionType", name: "Conversion Type", vr: "CS" },
  "0008,2111": {
    keyword: "DerivationDescription",
    name: "Derivation Description",
    vr: "ST",
  },
});

/**
 * Normalise une référence de tag vers la clé canonique « GGGG,EEEE »
 * (hexadécimal MAJUSCULE sur 4 chiffres). Renvoie `null` si la forme est
 * inexploitable.
 *
 * Formes acceptées (insensibles à la casse / aux espaces) :
 *   « 0010,0010 », « 00100010 », « x00100010 », « (0010,0010) »,
 *   « 0010 0010 », « 10,10 » (zéros de tête implicites).
 */
export function normalizeTag(tag: unknown): string | null {
  if (tag === null || tag === undefined) return null;
  // On retire tout sauf les hexa et les séparateurs, en minuscule de travail.
  let raw = String(tag).trim().toLowerCase();
  if (!raw) return null;
  // Préfixe « x » de dicom-parser (x00100010) et parenthèses.
  raw = raw.replace(/^x/, "").replace(/[()]/g, "");

  // Séparateur explicite (virgule / espace) → deux moitiés.
  const sep = raw.split(/[,\s]+/).filter(s => s.length > 0);
  let groupHex: string;
  let elemHex: string;
  if (sep.length === 2) {
    groupHex = sep[0];
    elemHex = sep[1];
  } else if (sep.length === 1 && sep[0].length === 8) {
    // Forme compacte 8 chiffres : 4 groupe + 4 élément.
    groupHex = sep[0].slice(0, 4);
    elemHex = sep[0].slice(4, 8);
  } else {
    return null;
  }

  // Chaque moitié doit être de l'hexa pur de 1 à 4 chiffres.
  if (!/^[0-9a-f]{1,4}$/.test(groupHex) || !/^[0-9a-f]{1,4}$/.test(elemHex)) {
    return null;
  }
  const group = groupHex.padStart(4, "0").toUpperCase();
  const element = elemHex.padStart(4, "0").toUpperCase();
  return `${group},${element}`;
}

/**
 * Résout un tag (toute forme acceptée par `normalizeTag`) en `ResolvedTag`.
 * Renvoie `null` si le tag est inexploitable OU absent du dictionnaire.
 */
export function lookupTag(tag: unknown): ResolvedTag | null {
  const key = normalizeTag(tag);
  if (key === null) return null;
  const info = TAG_DICTIONARY[key];
  if (!info) return null;
  const [group, element] = key.split(",");
  return { ...info, group, element, tag: key };
}

/** Mois (1..12) → nb de jours, avec gestion bissextile pour février. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Formate une date DICOM DA `YYYYMMDD` → « YYYY-MM-DD ». Brut si invalide. */
function formatDA(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return value;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12) return value;
  if (day < 1 || day > daysInMonth(year, month)) return value;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Formate une heure DICOM TM `HHMMSS(.ffffff)` → « HH:MM:SS(.ffffff) ». */
function formatTM(value: string): string {
  const m = /^(\d{2})(\d{2})?(\d{2})?(\.\d+)?$/.exec(value);
  if (!m) return value;
  const hh = parseInt(m[1], 10);
  const mm = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const ss = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  if (hh > 23 || mm > 59 || ss > 60) return value;
  const parts = [m[1], m[2] ?? "00", m[3] ?? "00"];
  return parts.join(":") + (m[4] ?? "");
}

/** Formate un nom de personne DICOM PN (composants `^`) → « Nom, Prénom … ». */
function formatPN(value: string): string {
  // Les composants PN sont séparés par « ^ » : Famille^Prénom^Milieu^Préfixe^Suffixe.
  const comps = value.split("^").map(c => c.trim());
  const family = comps[0] ?? "";
  const given = comps.slice(1).filter(c => c.length > 0);
  if (family && given.length > 0) return `${family}, ${given.join(" ")}`;
  // Pas de prénom → on rend la partie famille (ou la valeur nettoyée des « ^ »).
  const joined = comps.filter(c => c.length > 0).join(" ");
  return joined || value;
}

/**
 * Formate un âge DICOM AS `nnnD/W/M/Y` → « nnn jour(s)/semaine(s)/… ». Brut si
 * la forme n'est pas reconnue.
 */
function formatAS(value: string): string {
  const m = /^(\d{3})([DWMY])$/.exec(value.toUpperCase());
  if (!m) return value;
  const n = parseInt(m[1], 10);
  const unit = { D: "jour", W: "semaine", M: "mois", Y: "an" }[m[2]] ?? "";
  if (!unit) return value;
  // « mois » invariable ; pluriel pour les autres si n > 1.
  if (unit === "mois") return `${n} mois`;
  return `${n} ${unit}${n > 1 ? "s" : ""}`;
}

/**
 * Formate une valeur DICOM brute pour l'affichage selon son VR. PURE et tolérante :
 *   • `null`/`undefined` → chaîne vide.
 *   • valeur non-chaîne → coercition via String().
 *   • multi-valeurs DICOM (séparateur « \ ») → jointes par « \ », chaque
 *     élément formaté individuellement quand le VR le justifie (DA, TM, PN, AS).
 *   • VR inconnu ou valeur non conforme → valeur d'origine (trimée), jamais
 *     d'exception ni de NaN.
 *
 * Les VR numériques (DS, IS, US, …) sont rendus tels quels (trimés) : on ne
 * reformate pas les nombres pour ne pas perdre la précision/notation DICOM.
 */
export function formatTagValue(vr: unknown, value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  const v = String(vr ?? "")
    .trim()
    .toUpperCase();

  // VR par valeur unique uniquement (SQ n'a pas de valeur texte affichable ici).
  if (v === "SQ") return "<Séquence>";

  // VR formatés élément par élément sur la multiplicité « \ ».
  const perElement: Record<string, (s: string) => string> = {
    DA: formatDA,
    TM: formatTM,
    DT: s => s, // datetime : rendu brut (formatage fin non requis ici)
    PN: formatPN,
    AS: formatAS,
  };

  const fmt = perElement[v];
  if (fmt) {
    return trimmed
      .split("\\")
      .map(part => fmt(part.trim()))
      .join("\\");
  }

  // Autres VR (numériques, textes, UID…) : valeur trimée telle quelle.
  return trimmed;
}

/**
 * Recherche des tags par sous-chaîne (insensible à la casse) sur la clé
 * canonique, le mot-clé, le libellé ou le VR. Une requête vide / non-chaîne
 * renvoie une liste vide. Résultats triés par clé « GGGG,EEEE » croissante,
 * donc déterministes.
 */
export function searchTags(query: unknown): ResolvedTag[] {
  if (query === null || query === undefined) return [];
  const q = String(query).trim().toLowerCase();
  if (q === "") return [];

  // Si la requête ressemble à un tag, on tente d'abord une normalisation pour
  // matcher la clé canonique même si l'utilisateur tape « x00100010 ».
  const asTag = normalizeTag(query);

  const out: ResolvedTag[] = [];
  for (const key of Object.keys(TAG_DICTIONARY)) {
    const info = TAG_DICTIONARY[key];
    const hay = [key, info.keyword, info.name, info.vr].join(" ").toLowerCase();
    const matches = hay.includes(q) || (asTag !== null && key === asTag);
    if (matches) {
      const [group, element] = key.split(",");
      out.push({ ...info, group, element, tag: key });
    }
  }
  out.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return out;
}
