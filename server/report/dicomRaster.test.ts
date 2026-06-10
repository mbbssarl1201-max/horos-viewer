import { describe, it, expect } from "vitest";
import dcmjs from "dcmjs";
import { PNG } from "pngjs";
import { renderDicomFrame } from "./dicomRaster";

function makeSyntheticDicom(photometric = "MONOCHROME2"): Buffer {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const px = new Int16Array([0, 1000, 2000, 4000]);
  const dataset: any = {
    Rows: 2,
    Columns: 2,
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: photometric,
    RescaleSlope: 1,
    RescaleIntercept: 0,
    PixelData: [px.buffer],
  };
  const denat = DicomMetaDictionary.denaturalizeDataset(dataset);
  const dict = new DicomDict({
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    MediaStorageSOPInstanceUID: "1.2.3.4",
  });
  dict.dict = denat;
  return Buffer.from(dict.write());
}

describe("renderDicomFrame", () => {
  it("mappe le fenêtrage WC2000/WW4000 -> extrêmes 0 et 255", () => {
    const { png, rows, cols } = renderDicomFrame(makeSyntheticDicom(), {
      windowCenter: 2000,
      windowWidth: 4000,
    });
    expect(rows).toBe(2);
    expect(cols).toBe(2);
    const img = PNG.sync.read(png);
    expect(img.data[0]).toBe(0);
    expect(img.data[(2 * 2 - 1) * 4]).toBe(255);
  });

  it("MONOCHROME1 inverse l'échelle", () => {
    const { png } = renderDicomFrame(makeSyntheticDicom("MONOCHROME1"), {
      windowCenter: 2000,
      windowWidth: 4000,
    });
    expect(PNG.sync.read(png).data[0]).toBe(255);
  });

  it("refuse un transfer syntax compressé", () => {
    const { DicomDict, DicomMetaDictionary } = dcmjs.data;
    const dict = new DicomDict({});
    // Le UID de transfer syntax passé au constructeur n'est qu'un indice
    // d'encodage : dict.write() normalise le méta-en-tête vers la syntaxe
    // réellement utilisée (Explicit VR LE). Pour produire un fichier dont le
    // méta-en-tête déclare littéralement une syntaxe COMPRESSÉE, on écrit
    // directement l'élément (0002,0010) dans dict.meta.
    dict.meta = {
      "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.4.90"] },
      "00020002": { vr: "UI", Value: ["1.2.840.10008.5.1.4.1.1.2"] },
      "00020003": { vr: "UI", Value: ["1.2.3.4"] },
    } as any;
    dict.dict = DicomMetaDictionary.denaturalizeDataset({
      Rows: 2,
      Columns: 2,
      BitsAllocated: 16,
      PixelRepresentation: 0,
      PhotometricInterpretation: "MONOCHROME2",
      PixelData: [new Int16Array([0, 0, 0, 0]).buffer],
    });
    expect(() =>
      renderDicomFrame(Buffer.from(dict.write()), {
        windowCenter: 0,
        windowWidth: 1,
      })
    ).toThrow(/compress/i);
  });
});
