import archiver from "archiver";
import { ENV } from "../_core/env";
import { listInstancesBySeries } from "../db";
import { storageGetBuffer } from "../storage";

/**
 * Segmentation CT open-source (TotalSegmentator) — auto-hébergée sur le GPU suisse.
 *
 * Récupère toutes les coupes DICOM d'une série (MinIO), les zippe, et les envoie
 * au microservice GPU qui renvoie les structures anatomiques détectées + leurs
 * volumes (mL). PHI confiné au GPU (jamais de cloud externe). NON certifié → aide.
 */
export interface SegStructure {
  name: string;
  volumeMl: number;
}
export interface SegOverlay {
  sliceIndex: number;
  pngBase64: string;
}
export interface SegResult {
  durationS: number;
  count: number;
  structures: SegStructure[];
  overlays?: SegOverlay[];
}

function zipBuffers(files: { name: string; buf: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 1 } });
    const chunks: Buffer[] = [];
    archive.on("data", c => chunks.push(c as Buffer));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const f of files) archive.append(f.buf, { name: f.name });
    archive.finalize();
  });
}

export async function segmentCtSeries(
  seriesId: number,
  opts?: { highRes?: boolean; overlayCount?: number; task?: string }
): Promise<SegResult> {
  if (!ENV.segServiceUrl) {
    throw new Error("Service de segmentation non configuré");
  }
  const instances = await listInstancesBySeries(seriesId);
  if (!instances.length) throw new Error("Série vide");

  const files: { name: string; buf: Buffer }[] = [];
  for (let i = 0; i < instances.length; i++) {
    const key = (instances[i] as any).storageKey as string | null;
    if (!key) continue;
    try {
      const buf = await storageGetBuffer(key);
      files.push({ name: `${String(i).padStart(5, "0")}.dcm`, buf });
    } catch {
      /* coupe manquante : on continue */
    }
  }
  if (!files.length) throw new Error("Aucune coupe récupérable");

  const zip = await zipBuffers(files);
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(zip)]), "series.zip");

  // fast=1 (3mm, défaut) rapide ; fast=0 (1.5mm) = haute précision, ~2x plus lent.
  const fastParam = opts?.highRes ? 0 : 1;
  const overlay = opts?.overlayCount ?? 0;
  const task = encodeURIComponent(opts?.task ?? "total");
  const resp = await fetch(
    `${ENV.segServiceUrl}/segment?fast=${fastParam}&overlay=${overlay}&task=${task}`,
    {
      method: "POST",
      headers: { "X-Seg-Token": ENV.segToken },
      body: fd,
      signal: AbortSignal.timeout(900_000),
    }
  );
  if (!resp.ok) {
    throw new Error(`Service segmentation HTTP ${resp.status}`);
  }
  return (await resp.json()) as SegResult;
}
