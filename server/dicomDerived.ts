/**
 * Build DICOM Part-10 buffers for annotation exports, using dcmjs:
 *   - a Basic Text / Comprehensive-style Structured Report (SR) carrying the
 *     measurement values (length mm, angle °, ROI area/mean/stddev) + evidence
 *     references to the source SOP instances;
 *   - a Grayscale Softcopy Presentation State (GSPS) referencing the images
 *     with graphic annotations (polyline/ellipse/point) + a VOI (W/L).
 *
 * Datasets are assembled by hand (DicomMetaDictionary.denaturalizeDataset +
 * DicomDict.write) for full control over the IOD; dcmjs's `derivations` API
 * requires a parsed reference dataset we don't have server-side. The objects
 * roundtrip through dcmjs's own reader and are valid Part-10 files.
 *
 * SCOPE / LIMITATIONS (documented):
 *   - The SR is a MINIMAL measurement report (TID 1500-flavoured but NOT a full
 *     TID 1500 template tree): one CONTAINER with NUM children per measurement
 *     and an evidence sequence. Real PACS/SR viewers accept it; advanced
 *     TID-1500 structuring (image library, tracking ids) is out of scope.
 *   - GSPS graphics are encoded in DISPLAY-relative units (see
 *     annotationGraphics.ts) because exact world→pixel mapping needs the image
 *     plane, unavailable server-side. The object is still valid and references
 *     the correct images + VOI.
 */

import dcmjs from "dcmjs";
import type { AnnotationDbType } from "../client/src/lib/annotationMapping";
import { extractMeasurements } from "./annotationMeasure";
import { extractGraphic } from "./annotationGraphics";

const DMD = dcmjs.data.DicomMetaDictionary;

// SOP Class UIDs.
const SOP_CLASS_BASIC_TEXT_SR = "1.2.840.10008.5.1.4.1.1.88.11";
const SOP_CLASS_GSPS = "1.2.840.10008.5.1.4.1.1.11.1";
// Generic referenced image SOP class fallback (Secondary Capture) when the
// source modality SOP class is unknown — keeps the reference well-formed.
const SOP_CLASS_SC = "1.2.840.10008.5.1.4.1.1.7";
const TS_EXPLICIT_LE = "1.2.840.10008.1.2.1";
// Org root for our implementation (Anthropic-free, MBBS placeholder UID root).
const IMPL_CLASS_UID = "1.2.826.0.1.3680043.10.1338.1";

// UCUM-coded measurement units used in the SR.
const UNIT_CODES: Record<string, { code: string; meaning: string }> = {
  mm: { code: "mm", meaning: "millimeter" },
  deg: { code: "deg", meaning: "degree" },
  mm2: { code: "mm2", meaning: "square millimeter" },
  "[hnsf'U]": { code: "[hnsf'U]", meaning: "Hounsfield unit" },
};

// SNOMED/DCM concept codes for measurement labels.
const CONCEPT_CODES: Record<
  string,
  { code: string; scheme: string; meaning: string }
> = {
  Length: { code: "410668003", scheme: "SCT", meaning: "Length" },
  Angle: { code: "G-A1F5", scheme: "SRT", meaning: "Angle" },
  Area: { code: "42798000", scheme: "SCT", meaning: "Area" },
  Mean: { code: "373098007", scheme: "SCT", meaning: "Mean" },
  "Standard Deviation": {
    code: "386136009",
    scheme: "SCT",
    meaning: "Standard Deviation",
  },
};

export interface ExportPatient {
  patientName?: string | null;
  patientId?: string | null;
  birthDate?: string | null;
  sex?: string | null;
}

export interface ExportInstanceRef {
  sopInstanceUid: string;
  sopClassUid?: string | null;
}

// One annotation to export (already authorized + loaded server-side).
export interface ExportAnnotation {
  type: AnnotationDbType;
  data: unknown;
  // Source SOP instance this annotation belongs to (resolved by the caller).
  referencedSopInstanceUid: string;
  referencedSopClassUid?: string | null;
}

export interface ExportContext {
  studyInstanceUid: string;
  seriesInstanceUid: string; // source series UID (referenced)
  patient: ExportPatient;
  // All distinct source instances of the series (for the evidence/reference).
  instances: ExportInstanceRef[];
  annotations: ExportAnnotation[];
  windowCenter?: number;
  windowWidth?: number;
}

function pn(name?: string | null) {
  // dcmjs PersonName VR accepts a plain string or { Alphabetic }.
  return name ? { Alphabetic: name } : undefined;
}

function refSopClass(uid?: string | null): string {
  return uid && /^[0-9.]+$/.test(uid) ? uid : SOP_CLASS_SC;
}

function writePart10(dataset: Record<string, unknown>): Buffer {
  const dict = new dcmjs.data.DicomDict({});
  dict.dict = DMD.denaturalizeDataset(dataset);
  dict.meta = DMD.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: TS_EXPLICIT_LE,
    ImplementationClassUID: IMPL_CLASS_UID,
    ImplementationVersionName: "MEDIVIEW_1",
  });
  return Buffer.from(dict.write());
}

function patientTags(p: ExportPatient): Record<string, unknown> {
  return {
    PatientName: pn(p.patientName) ?? "",
    PatientID: p.patientId ?? "",
    PatientBirthDate: p.birthDate ?? "",
    PatientSex: p.sex ?? "",
  };
}

/** Evidence reference covering the source series + its SOP instances. */
function referencedSopSequence(instances: ExportInstanceRef[]) {
  return instances.map(i => ({
    ReferencedSOPClassUID: refSopClass(i.sopClassUid),
    ReferencedSOPInstanceUID: i.sopInstanceUid,
  }));
}

/**
 * Build a DICOM SR Part-10 buffer encoding every numeric measurement found in
 * the supplied annotations. Returns the buffer + the new SR SOP Instance UID.
 */
export function buildStructuredReport(ctx: ExportContext): {
  buffer: Buffer;
  sopInstanceUid: string;
} {
  const sopInstanceUid = DMD.uid();
  const srSeriesUid = DMD.uid();

  // NUM content items, one per extracted measurement, grouped per annotation
  // so the source image reference travels with each value.
  const contentSequence: Record<string, unknown>[] = [];
  for (const ann of ctx.annotations) {
    const measurements = extractMeasurements(ann.type, ann.data);
    for (const meas of measurements) {
      const concept = CONCEPT_CODES[meas.label] ?? {
        code: "121206",
        scheme: "DCM",
        meaning: meas.label,
      };
      const unit = UNIT_CODES[meas.unit] ?? {
        code: meas.unit,
        meaning: meas.unit,
      };
      contentSequence.push({
        RelationshipType: "CONTAINS",
        ValueType: "NUM",
        ConceptNameCodeSequence: [
          {
            CodeValue: concept.code,
            CodingSchemeDesignator: concept.scheme,
            CodeMeaning: concept.meaning,
          },
        ],
        MeasuredValueSequence: [
          {
            // SR NumericValue VR is DS (string).
            NumericValue: String(Number(meas.value.toFixed(4))),
            MeasurementUnitsCodeSequence: [
              {
                CodeValue: unit.code,
                CodingSchemeDesignator: "UCUM",
                CodeMeaning: unit.meaning,
              },
            ],
          },
        ],
        // Tie the measurement to its source image (SCOORD-free minimal link).
        ContentSequence: [
          {
            RelationshipType: "SELECTED FROM",
            ValueType: "IMAGE",
            ReferencedSOPSequence: [
              {
                ReferencedSOPClassUID: refSopClass(ann.referencedSopClassUid),
                ReferencedSOPInstanceUID: ann.referencedSopInstanceUid,
              },
            ],
          },
        ],
      });
    }
  }

  const dataset: Record<string, unknown> = {
    SpecificCharacterSet: "ISO_IR 192",
    SOPClassUID: SOP_CLASS_BASIC_TEXT_SR,
    SOPInstanceUID: sopInstanceUid,
    StudyInstanceUID: ctx.studyInstanceUid,
    SeriesInstanceUID: srSeriesUid,
    SeriesNumber: 901,
    InstanceNumber: 1,
    Modality: "SR",
    Manufacturer: "MediView",
    ManufacturerModelName: "Horos Viewer",
    ...patientTags(ctx.patient),
    ContentDate: DMD.date(),
    ContentTime: DMD.time(),
    CompletionFlag: "COMPLETE",
    VerificationFlag: "UNVERIFIED",
    // Root CONTAINER.
    ValueType: "CONTAINER",
    ConceptNameCodeSequence: [
      {
        CodeValue: "126000",
        CodingSchemeDesignator: "DCM",
        CodeMeaning: "Imaging Measurement Report",
      },
    ],
    ContinuityOfContent: "SEPARATE",
    CurrentRequestedProcedureEvidenceSequence: [
      {
        StudyInstanceUID: ctx.studyInstanceUid,
        ReferencedSeriesSequence: [
          {
            SeriesInstanceUID: ctx.seriesInstanceUid,
            ReferencedSOPSequence: referencedSopSequence(ctx.instances),
          },
        ],
      },
    ],
    ContentSequence: contentSequence,
  };

  return { buffer: writePart10(dataset), sopInstanceUid };
}

/**
 * Build a GSPS Part-10 buffer referencing the source images with graphic
 * annotations + VOI (W/L). Returns the buffer + the new GSPS SOP Instance UID.
 */
export function buildPresentationState(ctx: ExportContext): {
  buffer: Buffer;
  sopInstanceUid: string;
} {
  const sopInstanceUid = DMD.uid();
  const prSeriesUid = DMD.uid();

  // One GraphicAnnotation item per annotation that has usable geometry, tied to
  // its source image. Annotations without points are simply skipped (fail-soft).
  const graphicAnnotationSequence: Record<string, unknown>[] = [];
  for (const ann of ctx.annotations) {
    const g = extractGraphic(ann.type, ann.data);
    if (!g) continue;
    const refImage = [
      {
        ReferencedSOPClassUID: refSopClass(ann.referencedSopClassUid),
        ReferencedSOPInstanceUID: ann.referencedSopInstanceUid,
      },
    ];
    graphicAnnotationSequence.push({
      ReferencedImageSequence: refImage,
      GraphicLayer: "MEASUREMENTS",
      GraphicObjectSequence: [
        {
          GraphicAnnotationUnits: "DISPLAY",
          GraphicDimensions: 2,
          NumberOfGraphicPoints: g.numberOfPoints,
          GraphicData: g.points,
          GraphicType: g.graphicType,
          GraphicFilled: "N",
        },
      ],
    });
  }

  // Reference EVERY source image in the series so the presentation applies.
  const referencedImages = ctx.instances.map(i => ({
    ReferencedSOPClassUID: refSopClass(i.sopClassUid),
    ReferencedSOPInstanceUID: i.sopInstanceUid,
  }));

  const dataset: Record<string, unknown> = {
    SpecificCharacterSet: "ISO_IR 192",
    SOPClassUID: SOP_CLASS_GSPS,
    SOPInstanceUID: sopInstanceUid,
    StudyInstanceUID: ctx.studyInstanceUid,
    SeriesInstanceUID: prSeriesUid,
    SeriesNumber: 902,
    InstanceNumber: 1,
    Modality: "PR",
    Manufacturer: "MediView",
    ManufacturerModelName: "Horos Viewer",
    ...patientTags(ctx.patient),
    ContentLabel: "ANNOTATIONS",
    ContentDescription: "MediView annotations",
    PresentationCreationDate: DMD.date(),
    PresentationCreationTime: DMD.time(),
    ReferencedSeriesSequence: [
      {
        SeriesInstanceUID: ctx.seriesInstanceUid,
        ReferencedImageSequence: referencedImages,
      },
    ],
    GraphicLayerSequence: [
      {
        GraphicLayer: "MEASUREMENTS",
        GraphicLayerOrder: 1,
        GraphicLayerRecommendedDisplayGrayscaleValue: 65535,
        GraphicLayerDescription: "MediView measurements",
      },
    ],
    PresentationLUTShape: "IDENTITY",
  };

  if (graphicAnnotationSequence.length > 0) {
    dataset.GraphicAnnotationSequence = graphicAnnotationSequence;
  }

  // Softcopy VOI LUT (W/L) applied to every referenced image, when supplied.
  if (
    typeof ctx.windowCenter === "number" &&
    typeof ctx.windowWidth === "number" &&
    Number.isFinite(ctx.windowCenter) &&
    Number.isFinite(ctx.windowWidth)
  ) {
    dataset.SoftcopyVOILUTSequence = [
      {
        ReferencedImageSequence: referencedImages,
        WindowCenter: String(ctx.windowCenter),
        WindowWidth: String(ctx.windowWidth),
      },
    ];
  }

  return { buffer: writePart10(dataset), sopInstanceUid };
}
