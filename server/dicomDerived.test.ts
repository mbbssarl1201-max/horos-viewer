import { describe, it, expect } from "vitest";
import dcmjs from "dcmjs";
import {
  buildStructuredReport,
  buildPresentationState,
  type ExportContext,
} from "./dicomDerived";

const DMD = dcmjs.data.DicomMetaDictionary;

function ctx(): ExportContext {
  return {
    studyInstanceUid: "1.2.3",
    seriesInstanceUid: "1.2.3.4",
    patient: { patientName: "DOE^JANE", patientId: "P1", sex: "F" },
    instances: [
      { sopInstanceUid: "1.2.3.4.5", sopClassUid: "1.2.840.10008.5.1.4.1.1.2" },
    ],
    annotations: [
      {
        type: "length",
        referencedSopInstanceUid: "1.2.3.4.5",
        referencedSopClassUid: "1.2.840.10008.5.1.4.1.1.2",
        data: {
          cachedStats: { "imageId:0": { length: 42.73 } },
          handles: {
            points: [
              [0, 0, 0],
              [10, 20, 0],
            ],
          },
        },
      },
      {
        type: "ellipse_roi",
        referencedSopInstanceUid: "1.2.3.4.5",
        data: {
          cachedStats: { k: { area: 88.2, mean: 41, stdDev: 12.3 } },
          handles: {
            points: [
              [0, 5, 0],
              [10, 5, 0],
              [5, 0, 0],
              [5, 10, 0],
            ],
          },
        },
      },
    ],
    windowCenter: 40,
    windowWidth: 400,
  };
}

describe("buildStructuredReport", () => {
  it("produces a valid Part-10 SR that roundtrips with measurements", () => {
    const { buffer, sopInstanceUid } = buildStructuredReport(ctx());
    expect(buffer.byteLength).toBeGreaterThan(128);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const back = dcmjs.data.DicomMessage.readFile(ab);
    const nat = DMD.naturalizeDataset(back.dict);
    expect(nat.SOPInstanceUID).toBe(sopInstanceUid);
    expect(nat.Modality).toBe("SR");
    expect(nat.SOPClassUID).toBe("1.2.840.10008.5.1.4.1.1.88.11");
    // length + (area, mean, stdDev) = 4 NUM content items
    const content = Array.isArray(nat.ContentSequence)
      ? nat.ContentSequence
      : [nat.ContentSequence];
    expect(content).toHaveLength(4);
    expect(content[0].ValueType).toBe("NUM");
    // dcmjs naturalizes the DS string back to a number on read.
    expect(Number(content[0].MeasuredValueSequence[0].NumericValue)).toBe(
      42.73
    );
  });

  it("produces a valid empty-measurement SR (no annotations)", () => {
    const c = ctx();
    c.annotations = [];
    const { buffer } = buildStructuredReport(c);
    expect(buffer.byteLength).toBeGreaterThan(128);
  });
});

describe("buildPresentationState", () => {
  it("produces a valid Part-10 GSPS with graphics + VOI", () => {
    const { buffer, sopInstanceUid } = buildPresentationState(ctx());
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const back = dcmjs.data.DicomMessage.readFile(ab);
    const nat = DMD.naturalizeDataset(back.dict);
    expect(nat.SOPInstanceUID).toBe(sopInstanceUid);
    expect(nat.Modality).toBe("PR");
    expect(nat.SOPClassUID).toBe("1.2.840.10008.5.1.4.1.1.11.1");
    const ga = Array.isArray(nat.GraphicAnnotationSequence)
      ? nat.GraphicAnnotationSequence
      : [nat.GraphicAnnotationSequence];
    // length (POLYLINE) + ellipse (ELLIPSE) = 2 graphic annotations
    expect(ga).toHaveLength(2);
    expect(Number(nat.SoftcopyVOILUTSequence[0].WindowWidth)).toBe(400);
  });

  it("produces a valid GSPS even with no drawable annotations", () => {
    const c = ctx();
    c.annotations = [];
    const { buffer } = buildPresentationState(c);
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const nat = DMD.naturalizeDataset(
      dcmjs.data.DicomMessage.readFile(ab).dict
    );
    expect(nat.SOPClassUID).toBe("1.2.840.10008.5.1.4.1.1.11.1");
  });
});
