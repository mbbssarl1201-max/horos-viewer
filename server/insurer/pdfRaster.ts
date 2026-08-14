// Rastérisation d'un PDF scanné (photocopieuse Brother du cabinet → mail avec
// PDF image, sans couche texte) en pages PNG pour l'extraction vision.
// Dépend de `pdftoppm` (poppler-utils, installé dans l'image Docker prod) ;
// en son absence l'appelant retombe sur le motif « PDF scanné non lisible »
// et la demande part en validation humaine — jamais de perte silencieuse.
import { execFile } from "child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Aligné sur la limite d'images de `extraireDemande` (8 max côté vision) :
// rastériser au-delà serait du travail jeté.
export const PDF_RASTER_MAX_PAGES = 8;
const PDF_RASTER_DPI = "150";
const PDF_RASTER_TIMEOUT_MS = 60_000;

export async function rasteriserPdf(pdf: Buffer): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "insurer-pdf-"));
  try {
    const src = join(dir, "in.pdf");
    await writeFile(src, pdf);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "pdftoppm",
        [
          "-png",
          "-r",
          PDF_RASTER_DPI,
          "-f",
          "1",
          "-l",
          String(PDF_RASTER_MAX_PAGES),
          src,
          join(dir, "page"),
        ],
        { timeout: PDF_RASTER_TIMEOUT_MS },
        err => (err ? reject(err) : resolve())
      );
    });
    const fichiers = (await readdir(dir))
      .filter(f => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    const pages: Buffer[] = [];
    for (const f of fichiers) {
      pages.push(await readFile(join(dir, f)));
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
