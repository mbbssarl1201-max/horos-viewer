/**
 * Pure helpers to parse/format a Modality Worklist (MWL) answer coming back
 * from Orthanc's `/modalities/{id}/find-worklist` REST endpoint into typed,
 * UI-ready Scheduled Procedure Steps.
 *
 * Orthanc returns each worklist answer as a DICOM-JSON-ish object keyed by
 * 8-hex-digit tags, e.g. `{ "00100010": { "Value": ["DOE^JANE"] }, ... }`.
 * The Scheduled Procedure Step details live in a nested sequence (SQ) under
 * tag 0040,0100 (ScheduledProcedureStepSequence). We flatten the first step.
 *
 * Side-effect free so it can be unit-tested under the vitest `server/**`
 * include. Tolerant of partial/empty answers — a demo PACS often returns few
 * tags, and we must never throw on a missing field (fail-soft worklist).
 */

// Tags we read (group+element, 8 hex digits, dcmjs dict format).
const TAG_PATIENT_NAME = "00100010";
const TAG_PATIENT_ID = "00100020";
const TAG_PATIENT_BIRTH_DATE = "00100030";
const TAG_PATIENT_SEX = "00100040";
const TAG_ACCESSION = "00080050";
const TAG_REQUESTED_PROCEDURE_DESC = "00321060";
const TAG_SPS_SEQUENCE = "00400100"; // ScheduledProcedureStepSequence (SQ)
const TAG_SPS_MODALITY = "00080060";
const TAG_SPS_START_DATE = "00400002";
const TAG_SPS_START_TIME = "00400003";
const TAG_SPS_DESCRIPTION = "00400007";
const TAG_SPS_STATION_AET = "00400001";
const TAG_SPS_PHYSICIAN = "00400006"; // ScheduledPerformingPhysicianName

export interface WorklistEntry {
  patientName: string;
  patientId: string;
  patientBirthDate: string;
  patientSex: string;
  accessionNumber: string;
  modality: string;
  scheduledDate: string; // raw DICOM DA (YYYYMMDD) or ""
  scheduledTime: string; // raw DICOM TM (HHMMSS[.ffffff]) or ""
  scheduledDateTime: string; // human-readable, formatted
  procedureDescription: string;
  scheduledStationAet: string;
  performingPhysician: string;
}

// A single DICOM-JSON element: { vr?, Value?: unknown[] }.
type DicomElement = { Value?: unknown[]; vr?: string } | undefined;
type DicomAnswer = Record<string, DicomElement>;

/** First scalar string Value of a DICOM-JSON element, or "". */
function firstValue(el: DicomElement): string {
  const v = el?.Value;
  if (!Array.isArray(v) || v.length === 0) return "";
  const first = v[0];
  if (first == null) return "";
  // PersonName values are objects like { Alphabetic: "DOE^JANE" }.
  if (typeof first === "object") {
    const alpha = (first as { Alphabetic?: unknown }).Alphabetic;
    return typeof alpha === "string" ? alpha : "";
  }
  return String(first);
}

/** First item of a sequence (SQ) element, as a nested answer, or {}. */
function firstSequenceItem(el: DicomElement): DicomAnswer {
  const v = el?.Value;
  if (!Array.isArray(v) || v.length === 0) return {};
  const item = v[0];
  return item && typeof item === "object" ? (item as DicomAnswer) : {};
}

/** "DOE^JANE" → "DOE, JANE" (keep it readable, no PHI transformation). */
export function formatPersonName(raw: string): string {
  if (!raw) return "";
  const parts = raw.split("^").map(s => s.trim());
  const [family, given] = parts;
  if (family && given) return `${family}, ${given}`;
  return family || given || raw;
}

/** DICOM DA (YYYYMMDD) + TM (HHMMSS) → "YYYY-MM-DD HH:MM" (best-effort). */
export function formatScheduledDateTime(date: string, time: string): string {
  let out = "";
  if (/^\d{8}$/.test(date)) {
    out = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  } else if (date) {
    out = date;
  }
  if (/^\d{4,6}/.test(time)) {
    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4) || "00";
    out = out ? `${out} ${hh}:${mm}` : `${hh}:${mm}`;
  }
  return out;
}

/** Parse a single Orthanc worklist answer into a typed entry. */
export function parseWorklistAnswer(answer: DicomAnswer): WorklistEntry {
  const sps = firstSequenceItem(answer[TAG_SPS_SEQUENCE]);

  const scheduledDate = firstValue(sps[TAG_SPS_START_DATE]);
  const scheduledTime = firstValue(sps[TAG_SPS_START_TIME]);

  return {
    patientName: formatPersonName(firstValue(answer[TAG_PATIENT_NAME])),
    patientId: firstValue(answer[TAG_PATIENT_ID]),
    patientBirthDate: firstValue(answer[TAG_PATIENT_BIRTH_DATE]),
    patientSex: firstValue(answer[TAG_PATIENT_SEX]),
    accessionNumber: firstValue(answer[TAG_ACCESSION]),
    modality: firstValue(sps[TAG_SPS_MODALITY]),
    scheduledDate,
    scheduledTime,
    scheduledDateTime: formatScheduledDateTime(scheduledDate, scheduledTime),
    procedureDescription:
      firstValue(sps[TAG_SPS_DESCRIPTION]) ||
      firstValue(answer[TAG_REQUESTED_PROCEDURE_DESC]),
    scheduledStationAet: firstValue(sps[TAG_SPS_STATION_AET]),
    performingPhysician: formatPersonName(firstValue(sps[TAG_SPS_PHYSICIAN])),
  };
}

/** Parse a full list of Orthanc worklist answers. */
export function parseWorklistAnswers(answers: unknown): WorklistEntry[] {
  if (!Array.isArray(answers)) return [];
  return answers
    .filter((a): a is DicomAnswer => !!a && typeof a === "object")
    .map(parseWorklistAnswer);
}
