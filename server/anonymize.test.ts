import { describe, expect, it } from "vitest";
import dcmjs from "dcmjs";
import { anonymizeDicomBuffer } from "./routers";

const { DicomMessage, DicomMetaDictionary, DicomDict } = dcmjs.data;

// Build a valid in-memory DICOM (Explicit VR Little Endian) containing PHI,
// including PHI nested inside a sequence, plus non-PHI clinical fields.
function buildDicomBuffer(): Buffer {
  const dataset = {
    PatientName: "DOE^JOHN",
    PatientID: "PID-12345",
    PatientBirthDate: "19800101",
    PatientSex: "M",
    AccessionNumber: "ACC-999",
    ReferringPhysicianName: "SMITH^JANE",
    InstitutionName: "Secret Hospital",
    Modality: "CT",
    StudyDescription: "Chest CT",
    StudyInstanceUID: "1.2.3.4.5",
    SeriesInstanceUID: "1.2.3.4.5.1",
    SOPInstanceUID: "1.2.3.4.5.1.1",
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    // Nested sequence carrying PHI in a sub-item.
    RequestAttributesSequence: [
      { AccessionNumber: "ACC-NESTED", PatientID: "NESTED-PID" },
    ],
  };
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
    ImplementationClassUID: "1.2.3.4",
  };
  const dd = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dd.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  return Buffer.from(dd.write());
}

// A scrubbed tag naturalizes to "", [], [""], or undefined depending on its
// VR — treat all of those as "removed".
function isEmptyish(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.every(isEmptyish);
  if (typeof v === "object") return Object.values(v).every(isEmptyish);
  return false;
}

function readNaturalized(buffer: Buffer): Record<string, any> {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const parsed = DicomMessage.readFile(arrayBuffer, { ignoreErrors: true });
  return DicomMetaDictionary.naturalizeDataset(parsed.dict);
}

describe("anonymizeDicomBuffer", () => {
  it("removes top-level patient-identifying metadata", () => {
    const out = anonymizeDicomBuffer(buildDicomBuffer());
    const ds = readNaturalized(out);

    expect(isEmptyish(ds.PatientName)).toBe(true);
    expect(isEmptyish(ds.PatientID)).toBe(true);
    expect(isEmptyish(ds.PatientBirthDate)).toBe(true);
    expect(isEmptyish(ds.AccessionNumber)).toBe(true);
    expect(isEmptyish(ds.ReferringPhysicianName)).toBe(true);
    expect(isEmptyish(ds.InstitutionName)).toBe(true);

    // Belt-and-braces: the original PHI strings must not survive anywhere.
    const blob = JSON.stringify(ds);
    expect(blob).not.toContain("DOE^JOHN");
    expect(blob).not.toContain("PID-12345");
    expect(blob).not.toContain("Secret Hospital");
  });

  it("preserves non-PHI clinical fields", () => {
    const out = anonymizeDicomBuffer(buildDicomBuffer());
    const ds = readNaturalized(out);

    expect(ds.Modality).toBe("CT");
    expect(ds.StudyDescription).toBe("Chest CT");
    expect(ds.StudyInstanceUID).toBe("1.2.3.4.5");
  });

  it("scrubs PHI nested inside sequences", () => {
    const out = anonymizeDicomBuffer(buildDicomBuffer());
    const ds = readNaturalized(out);

    const item = Array.isArray(ds.RequestAttributesSequence)
      ? ds.RequestAttributesSequence[0]
      : ds.RequestAttributesSequence;
    expect(isEmptyish(item?.AccessionNumber)).toBe(true);
    expect(isEmptyish(item?.PatientID)).toBe(true);
  });

  it("fails closed (throws) on non-DICOM input rather than storing it as-is", () => {
    const garbage = Buffer.from("this is not a dicom file at all");
    expect(() => anonymizeDicomBuffer(garbage)).toThrow();
  });

  // Les CT Toshiba du cabinet contiennent des DS > 16 octets (non conformes
  // mais réels) ; l'anonymisation ne doit pas rejeter ces fichiers.
  it("accepts nonconforming over-long DS values instead of rejecting the file", () => {
    const longDs = "0.774637877941132"; // 17 car. + bourrage = 18 > max DS (16)
    const dd = new DicomDict(
      DicomMetaDictionary.denaturalizeDataset({
        FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
        MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
        MediaStorageSOPInstanceUID: "1.2.3.4.5.1.1",
        TransferSyntaxUID: "1.2.840.10008.1.2.1",
        ImplementationClassUID: "1.2.3.4",
      })
    );
    dd.dict = DicomMetaDictionary.denaturalizeDataset({
      PatientName: "DOE^JOHN",
      Modality: "CT",
      StudyInstanceUID: "1.2.3.4.5",
      SeriesInstanceUID: "1.2.3.4.5.1",
      SOPInstanceUID: "1.2.3.4.5.1.1",
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    });
    // Tag DS injecté brut (denaturalize tronquerait) : 17 caractères sérialisés
    // + octet de bourrage pair DICOM = 18 > max 16, comme dans les fichiers réels.
    dd.dict["00180050"] = { vr: "DS", Value: [longDs] };
    const input = Buffer.from(dd.write({ allowInvalidVRLength: true }));

    const out = anonymizeDicomBuffer(input);
    const ds = readNaturalized(out);
    expect(isEmptyish(ds.PatientName)).toBe(true);
    expect(String(ds.SliceThickness)).toContain(longDs);
  });
});
