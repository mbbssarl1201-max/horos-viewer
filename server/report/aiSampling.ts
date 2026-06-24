import { listInstancesBySeries } from "../db";
import { storageGetBuffer } from "../storage";
import { renderDicomFrame } from "./dicomRaster";
import { downscalePngBase64 } from "./aiPreanalysis";

/**
 * Échantillonnage des coupes d'une série pour donner à l'IA une vue de TOUT le
 * volume (et non d'une seule coupe). Le rendu serveur réutilise la même brique
 * que le ciné MP4 (renderDicomFrame), dans la MÊME fenêtre que le médecin (W/L)
 * — important : une fracture n'est visible qu'en fenêtre osseuse.
 */

/**
 * Choisit `n` indices RÉPARTIS UNIFORMÉMENT sur `[0, total)`, en incluant la
 * première et la dernière coupe (couverture maximale du volume). Fonction PURE.
 */
export function pickSampleIndices(total: number, n: number): number[] {
  if (total <= 0 || n <= 0) return [];
  if (n >= total) return Array.from({ length: total }, (_, i) => i);
  if (n === 1) return [Math.floor(total / 2)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round((i * (total - 1)) / (n - 1)));
  }
  // Le rinçage des doublons (collisions d'arrondi sur petits volumes) préserve
  // l'ordre croissant.
  return Array.from(new Set(out));
}

export interface SampledSlice {
  pngBase64: string;
  sliceNumber: number;
}

/**
 * Rend `count` coupes réparties sur toute la série, étiquetées par leur numéro.
 * Best-effort : une coupe qui ne se rend pas (transfer syntax compressé) est
 * sautée, jamais bloquante.
 */
export async function sampleSeriesPngs(
  seriesId: number,
  opts: {
    windowCenter: number;
    windowWidth: number;
    count: number;
    maxDim?: number;
  }
): Promise<{ images: SampledSlice[]; totalSlices: number }> {
  const instances = (await listInstancesBySeries(seriesId))
    .slice()
    .sort(
      (a: any, b: any) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)
    );
  const total = instances.length;
  const idxs = pickSampleIndices(total, opts.count);
  const images: SampledSlice[] = [];
  for (const i of idxs) {
    const inst: any = instances[i];
    try {
      const dicom = await storageGetBuffer(inst.storageKey);
      const { png } = renderDicomFrame(dicom, {
        windowCenter: opts.windowCenter,
        windowWidth: opts.windowWidth,
      });
      images.push({
        pngBase64: downscalePngBase64(
          png.toString("base64"),
          opts.maxDim ?? 768
        ),
        sliceNumber: inst.instanceNumber ?? i + 1,
      });
    } catch {
      // coupe non rendable (compressée) → on saute, on garde les autres
    }
  }
  return { images, totalSlices: total };
}

/**
 * Rend UNE coupe précise (par son numéro) — celle que l'IA a désignée comme
 * portant l'anomalie — pour l'utiliser comme image clé du compte rendu.
 */
export async function renderSliceByNumber(
  seriesId: number,
  sliceNumber: number,
  opts: { windowCenter?: number; windowWidth?: number; maxDim?: number }
): Promise<string | null> {
  const instances = await listInstancesBySeries(seriesId);
  const sorted = instances
    .slice()
    .sort(
      (a: any, b: any) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)
    );
  const inst: any =
    sorted.find((x: any) => x.instanceNumber === sliceNumber) ??
    sorted[sliceNumber - 1];
  if (!inst) return null;
  try {
    const dicom = await storageGetBuffer(inst.storageKey);
    const { png } = renderDicomFrame(dicom, {
      windowCenter: opts.windowCenter,
      windowWidth: opts.windowWidth,
    });
    return downscalePngBase64(png.toString("base64"), opts.maxDim ?? 1024);
  } catch {
    return null;
  }
}
