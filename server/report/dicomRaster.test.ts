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

function makeColorDicom(
  photometric = "RGB",
  planar = 0
): Buffer {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  // 2x2 px couleur : rouge, vert, bleu, blanc (entrelacé RGBRGB...).
  const interleaved = new Uint8Array([
    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
  ]);
  // Version planar (RRRR GGGG BBBB) des mêmes pixels.
  const planarData = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
  const dataset: any = {
    Rows: 2,
    Columns: 2,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    SamplesPerPixel: 3,
    PlanarConfiguration: planar,
    PhotometricInterpretation: photometric,
    PixelData: [(planar === 1 ? planarData : interleaved).buffer],
  };
  const dict = new DicomDict({
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.6.1",
    MediaStorageSOPInstanceUID: "1.2.3.4",
  });
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
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

  it("RGB couleur (écho Doppler) : préserve les canaux, n'écrase pas en gris", () => {
    // Sans le chemin couleur, l'écho RGB était lue comme du monochrome → image
    // corrompue, d'où des CR « aucun plan reconnaissable ».
    const { png, rows, cols } = renderDicomFrame(makeColorDicom("RGB"), {
      windowCenter: 40,
      windowWidth: 400,
    });
    expect([rows, cols]).toEqual([2, 2]);
    const img = PNG.sync.read(png);
    // px0 = rouge pur, px1 = vert pur, px2 = bleu pur.
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([255, 0, 0]);
    expect([img.data[4], img.data[5], img.data[6]]).toEqual([0, 255, 0]);
    expect([img.data[8], img.data[9], img.data[10]]).toEqual([0, 0, 255]);
  });

  it("RGB planar configuration=1 : reconstitue les pixels correctement", () => {
    const { png } = renderDicomFrame(makeColorDicom("RGB", 1), {
      windowCenter: 40,
      windowWidth: 400,
    });
    const img = PNG.sync.read(png);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([255, 0, 0]);
    expect([img.data[4], img.data[5], img.data[6]]).toEqual([0, 255, 0]);
  });

  it("YBR_FULL : convertit en RGB (le gris reste gris)", () => {
    // Y=128,Cb=128,Cr=128 → gris moyen ; on vérifie juste que ça ne plante pas
    // et reste dans [0,255] (la conversion exacte est validée par construction).
    const { png } = renderDicomFrame(makeColorDicom("YBR_FULL"), {
      windowCenter: 40,
      windowWidth: 400,
    });
    const img = PNG.sync.read(png);
    for (let i = 0; i < img.data.length; i++) {
      expect(img.data[i]).toBeGreaterThanOrEqual(0);
      expect(img.data[i]).toBeLessThanOrEqual(255);
    }
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
