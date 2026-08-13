import archiver from "archiver";
import { randomBytes, createHash } from "crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  getStudyById,
  listSeriesByStudy,
  listInstancesBySeries,
} from "../db";
import { storagePut, storageGetBuffer } from "../storage";
import { buildStudyExportPdf } from "../report/reportPdf";
import { insurerBundleTokens } from "../../drizzle/schema";

const QUATORZE_JOURS_MS = 14 * 24 * 60 * 60 * 1000;
// Plafond de rédemptions par jeton (multi-téléchargement INTENTIONNEL — l'assureur
// peut retélécharger le colis pendant la fenêtre de validité, cf. décision du
// gérant/I2) : au-delà, le jeton est traité comme épuisé (même issue générique
// que expiré/révoqué), pour borner l'exposition d'un lien qui fuiterait.
const PLAFOND_TELECHARGEMENTS = 10;

/**
 * Zippe des buffers en mémoire (copie de `server/report/ctSegmentation.ts`,
 * niveau de compression 6 : le colis contient surtout des DICOM déjà
 * volumineux et incompressibles, pas la peine de viser le niveau max).
 */
function zipBuffers(files: { name: string; buf: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", c => chunks.push(c as Buffer));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const f of files) archive.append(f.buf, { name: f.name });
    archive.finalize();
  });
}

/**
 * Construit le colis DICOM+CR d'une demande assureur : toutes les coupes des
 * études données (arborescence `etude-<id>/serie-<id>/<sop>.dcm`) + un CR PDF
 * par étude à la racine, zippés et déposés dans MinIO sous
 * `insurer/<requestId>/bundle.zip`.
 */
export async function construireColis(
  requestId: number,
  studyIds: number[]
): Promise<{ bundleKey: string; tailleOctets: number }> {
  const files: { name: string; buf: Buffer }[] = [];

  for (const studyId of studyIds) {
    const study = await getStudyById(studyId);
    if (!study) continue;

    const seriesList = await listSeriesByStudy(studyId);
    for (const s of seriesList) {
      const instances = await listInstancesBySeries(s.id);
      for (const inst of instances) {
        const key = (inst as any).storageKey as string | null;
        if (!key) continue;
        try {
          const buf = await storageGetBuffer(key);
          const sop = (inst as any).sopInstanceUid || String((inst as any).id);
          files.push({
            name: `etude-${studyId}/serie-${s.id}/${sop}.dcm`,
            buf,
          });
        } catch {
          /* coupe manquante : on continue */
        }
      }
    }

    try {
      const pdf = buildStudyExportPdf(study);
      files.push({ name: `CR-etude-${studyId}.pdf`, buf: pdf });
    } catch {
      /* PDF indisponible : on continue sans bloquer le colis */
    }
  }

  const zip = await zipBuffers(files);
  const { key } = await storagePut(
    `insurer/${requestId}/bundle.zip`,
    zip,
    "application/zip"
  );
  return { bundleKey: key, tailleOctets: zip.length };
}

/** Crée un jeton de téléchargement (32 octets aléatoires, hash SHA-256 stocké, 14 j). */
export async function creerJeton(
  requestId: number,
  bundleKey: string
): Promise<{ tokenClair: string }> {
  const db = await getDb();
  if (!db) throw new Error("Base de données indisponible");

  const tokenClair = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(tokenClair).digest("hex");
  const expireLe = new Date(Date.now() + QUATORZE_JOURS_MS);

  await db.insert(insurerBundleTokens).values({
    requestId,
    tokenHash,
    bundleKey,
    expireLe,
  });

  return { tokenClair };
}

/**
 * Rachète un jeton en clair contre la clé MinIO du colis. Refuse (générique)
 * si le jeton est inconnu, expiré, révoqué, OU déjà racheté
 * `PLAFOND_TELECHARGEMENTS` fois (cf. audit I2 : le multi-téléchargement
 * pendant la fenêtre de validité est intentionnel, mais borné). Journalise
 * le téléchargement (horodatage + IP) en cas de succès — audit nLPD.
 */
export async function racheterJeton(
  tokenClair: string,
  ip: string
): Promise<{ ok: true; bundleKey: string } | { ok: false }> {
  const db = await getDb();
  if (!db) return { ok: false };

  const tokenHash = createHash("sha256").update(tokenClair).digest("hex");
  const rows = await db
    .select()
    .from(insurerBundleTokens)
    .where(eq(insurerBundleTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false };
  if (row.revoqueLe) return { ok: false };
  if (row.expireLe.getTime() <= Date.now()) return { ok: false };

  const telechargements = [...(row.telechargements ?? [])];
  if (telechargements.length >= PLAFOND_TELECHARGEMENTS) return { ok: false };

  telechargements.push({ ts: new Date().toISOString(), ip });
  await db
    .update(insurerBundleTokens)
    .set({ telechargements })
    .where(eq(insurerBundleTokens.id, row.id));

  return { ok: true, bundleKey: row.bundleKey };
}
