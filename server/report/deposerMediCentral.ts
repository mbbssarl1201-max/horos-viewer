// server/report/deposerMediCentral.ts
//
// À la SIGNATURE d'un compte-rendu radiologique, pousse automatiquement vers MediCentral
// (dossier patient → onglet Imagerie) : le CR (PDF) + une vidéo CINÉ de la série clé
// (« comme un radiologue scrolle l'étude »). App-à-app, secret partagé. Non-bloquant :
// toute erreur est journalisée, jamais propagée (la signature ne doit pas échouer pour ça).
//
// Activation : MEDICENTRAL_DEPOT_URL + IMAGERIE_DEPOT_SECRET. Idempotent côté MediCentral
// (dédup par accession/studyUid). Le rapprochement patient (nom+DDN, flou) est fait là-bas.
import {
  getStudyById,
  getReportByStudy,
  listSeriesByStudy,
  listInstancesBySeries,
} from "../db";
import { storageGetBuffer } from "../storage";
import { renderDicomFrame } from "./dicomRaster";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";
import { buildReportPdf } from "./reportPdf";

const trim = (s?: string | null) => (s ?? "").trim();
const MAX_FRAMES = 60;
const FPS = 8;

function depotActif(): boolean {
  return (
    !!trim(process.env.MEDICENTRAL_DEPOT_URL) &&
    !!trim(process.env.IMAGERIE_DEPOT_SECRET)
  );
}

/** DICOM DA "YYYYMMDD" → "YYYY-MM-DD" (laisse tel quel si déjà formaté). */
function dicomDaToIso(d?: string | null): string {
  const s = trim(d);
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function subsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function premierNombre(v?: string | null): number | undefined {
  const s = trim(v);
  if (!s) return undefined;
  const n = Number(s.split("\\")[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** Dépôt non-bloquant du CR + ciné vers MediCentral pour une étude signée. */
export async function deposerVersMediCentral(studyId: number): Promise<void> {
  if (!depotActif()) return;
  try {
    const study = await getStudyById(studyId);
    if (!study) return;
    const report = await getReportByStudy(studyId);
    if (!report || report.status !== "signed") return;

    // Identité patient : patientName DICOM "FAMILLE^PRENOM".
    const pn = trim(study.patientName);
    const parts = pn.split("^");
    const nom = trim(parts[0] || pn);
    const prenom = trim(parts[1] || "");
    const dateNaissance = dicomDaToIso(study.birthDate);
    if (!nom) return;

    // 1) CR PDF.
    const pdf = buildReportPdf({
      study,
      report: {
        indication: report.indication ?? "",
        technique: report.technique ?? "",
        resultats: report.resultats ?? "",
        conclusion: report.conclusion ?? "",
      },
      signature: "Signé — transmis automatiquement par MediView",
      keyImages: [],
      aiAssisted: report.aiGenerated,
      antecedents: "",
    });

    // 2) Ciné de la SÉRIE CLÉ (la plus volumineuse = la séquence diagnostique).
    let mp4: Buffer | null = null;
    if (ffmpegAvailable()) {
      const series = await listSeriesByStudy(studyId);
      const keySeries = series
        .slice()
        .sort(
          (a: any, b: any) =>
            (b.numberOfInstances ?? 0) - (a.numberOfInstances ?? 0)
        )[0];
      if (keySeries) {
        const instances = (await listInstancesBySeries(keySeries.id))
          .slice()
          .sort(
            (a: any, b: any) =>
              (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)
          );
        if (instances.length >= 2) {
          const frames: Buffer[] = [];
          for (const inst of subsample(instances, MAX_FRAMES)) {
            try {
              const dicom = await storageGetBuffer((inst as any).storageKey);
              const { png } = renderDicomFrame(dicom, {
                windowCenter: premierNombre((inst as any).windowCenter),
                windowWidth: premierNombre((inst as any).windowWidth),
              });
              frames.push(png);
            } catch {
              /* coupe illisible → on saute */
            }
          }
          if (frames.length >= 2)
            mp4 = await buildCineMp4(frames, { fps: FPS });
        }
      }
    }

    // 3) POST multipart vers MediCentral (fetch/FormData/Blob natifs Node 22).
    const form = new FormData();
    form.append("nom", nom);
    form.append("prenom", prenom);
    form.append("dateNaissance", dateNaissance);
    form.append("accession", String(study.studyInstanceUid || study.id));
    form.append("studyDescription", trim(study.studyDescription));
    form.append(
      "pdf",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      `CR-${studyId}.pdf`
    );
    if (mp4)
      form.append(
        "video",
        new Blob([new Uint8Array(mp4)], { type: "video/mp4" }),
        `cine-${studyId}.mp4`
      );

    const res = await fetch(trim(process.env.MEDICENTRAL_DEPOT_URL), {
      method: "POST",
      headers: { "x-imagerie-secret": trim(process.env.IMAGERIE_DEPOT_SECRET) },
      body: form,
    });
    if (!res.ok)
      console.error(
        "[depotMediCentral] échec",
        res.status,
        await res.text().catch(() => "")
      );
    else console.log(`[depotMediCentral] OK étude ${studyId}`);
  } catch (e) {
    console.error("[depotMediCentral] erreur:", (e as Error)?.message);
  }
}
