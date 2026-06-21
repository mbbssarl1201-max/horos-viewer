import dcmjs from "dcmjs";
import { PNG } from "pngjs";

const UNCOMPRESSED = new Set([
  "1.2.840.10008.1.2", // Implicit VR LE
  "1.2.840.10008.1.2.1", // Explicit VR LE
  "1.2.840.10008.1.2.2", // Explicit VR BE
]);

export interface Windowing {
  windowCenter: number;
  windowWidth: number;
}
export interface RenderedFrame {
  png: Buffer;
  rows: number;
  cols: number;
}

export function renderDicomFrame(
  dicomBuffer: Buffer,
  win: Windowing
): RenderedFrame {
  const arrayBuffer = dicomBuffer.buffer.slice(
    dicomBuffer.byteOffset,
    dicomBuffer.byteOffset + dicomBuffer.byteLength
  ) as ArrayBuffer;
  const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer, {
    ignoreErrors: false,
  });
  const ts: string = dicomDict.meta?.["00020010"]?.Value?.[0] ?? "";
  if (ts && !UNCOMPRESSED.has(ts)) {
    throw new Error(`Transfer syntax compressé non supporté en v1 : ${ts}`);
  }
  const ds: any = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomDict.dict
  );
  const rows: number = ds.Rows;
  const cols: number = ds.Columns;
  const bits: number = ds.BitsAllocated ?? 16;
  const signed: boolean = (ds.PixelRepresentation ?? 0) === 1;
  const slope: number = Number(ds.RescaleSlope ?? 1) || 1;
  const intercept: number = Number(ds.RescaleIntercept ?? 0) || 0;
  const photometric: string = ds.PhotometricInterpretation ?? "";
  const mono1: boolean = photometric === "MONOCHROME1";
  const samplesPerPixel: number = ds.SamplesPerPixel ?? 1;
  const planar: number = ds.PlanarConfiguration ?? 0;
  const pdRaw = Array.isArray(ds.PixelData) ? ds.PixelData[0] : ds.PixelData;
  const pixelBuffer = (
    pdRaw instanceof ArrayBuffer ? pdRaw : pdRaw.buffer
  ) as ArrayBuffer;

  // --- IMAGES COULEUR (échographie Doppler, captures secondaires…) ----------
  // Indispensable : sans ce chemin, une écho RGB/YBR était lue comme du
  // monochrome (octets RGB interprétés comme des pixels gris séquentiels) →
  // image CORROMPUE envoyée à l'IA, d'où des CR « aucun plan reconnaissable ».
  // Le Doppler couleur (flux rouge/bleu) porte de l'information diagnostique :
  // on la PRÉSERVE.
  if (samplesPerPixel === 3) {
    const u8 = new Uint8Array(pixelBuffer);
    const isYbr = photometric.startsWith("YBR");
    const png = new PNG({ width: cols, height: rows });
    const n = rows * cols;
    for (let i = 0; i < n; i++) {
      let r: number, g: number, b: number;
      if (planar === 1) {
        // R plane, puis G plane, puis B plane.
        r = u8[i] ?? 0;
        g = u8[n + i] ?? 0;
        b = u8[2 * n + i] ?? 0;
      } else {
        // Entrelacé : R,G,B,R,G,B…
        r = u8[i * 3] ?? 0;
        g = u8[i * 3 + 1] ?? 0;
        b = u8[i * 3 + 2] ?? 0;
      }
      if (isYbr) {
        // YBR_FULL → RGB (ITU-R BT.601). YBR_FULL_422 est déjà sur-échantillonné
        // à l'identique par la plupart des modalités US ; on traite en FULL.
        const Y = r,
          Cb = g - 128,
          Cr = b - 128;
        r = Y + 1.402 * Cr;
        g = Y - 0.344136 * Cb - 0.714136 * Cr;
        b = Y + 1.772 * Cb;
      }
      const o = i * 4;
      png.data[o] = Math.max(0, Math.min(255, Math.round(r)));
      png.data[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      png.data[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      png.data[o + 3] = 255;
    }
    return { png: PNG.sync.write(png), rows, cols };
  }

  // --- IMAGES MONOCHROMES (CT/MR/CR/US niveaux de gris) ----------------------
  let samples: ArrayLike<number>;
  if (bits === 16)
    samples = signed
      ? new Int16Array(pixelBuffer)
      : new Uint16Array(pixelBuffer);
  else samples = new Uint8Array(pixelBuffer);
  const lower = win.windowCenter - win.windowWidth / 2;
  const span = win.windowWidth <= 0 ? 1 : win.windowWidth;
  const png = new PNG({ width: cols, height: rows });
  for (let i = 0; i < rows * cols; i++) {
    const hu = samples[i] * slope + intercept;
    let g = Math.round(((hu - lower) / span) * 255);
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (mono1) g = 255 - g;
    const o = i * 4;
    png.data[o] = g;
    png.data[o + 1] = g;
    png.data[o + 2] = g;
    png.data[o + 3] = 255;
  }
  return { png: PNG.sync.write(png), rows, cols };
}
