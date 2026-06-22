import { ENV } from "../_core/env";

/**
 * Connecteur « détecteur d'IA radiologique CERTIFIÉ CE » (plateforme deepc /
 * Incepto / Blackford). Contrairement à l'assistant Opus (généraliste, NON
 * certifié), ces détecteurs sont des dispositifs médicaux marqués CE → ce sont
 * EUX qui « détectent » fiablement fractures / nodules / hémorragies.
 *
 * Activation = ENV (DETECTOR_PROVIDER + DETECTOR_API_URL + DETECTOR_API_KEY).
 * Vide ⇒ désactivé (aucun changement de comportement). `mock` ⇒ démo sans clé.
 * `http` ⇒ vraie plateforme : à brancher UNIQUEMENT sur un hébergement CH/UE
 * sous DPA (nLPD/secret médical) — JAMAIS de cloud US pour du PHI.
 *
 * NB : l'API exacte (push DICOMweb/STOW, polling, format des résultats) dépend
 * de l'éditeur retenu. Le provider `http` ci-dessous est un ADAPTATEUR générique
 * à ajuster au contrat signé ; la forme normalisée (DetectorFinding) reste stable.
 */

export interface DetectorFinding {
  app: string; // application certifiée (ex. "Gleamer BoneView")
  label: string; // ex. "Fracture", "Nodule pulmonaire", "Hémorragie"
  bodyPart?: string; // ex. "Épaule gauche"
  confidence?: number; // 0..1
  severity?: "low" | "moderate" | "high";
  seriesId?: number;
  sliceNumber?: number;
  bbox?: { x: number; y: number; w: number; h: number }; // repère sur l'image
  ceClass?: string; // classe du marquage CE
}

export interface DetectorResult {
  enabled: boolean;
  provider: string; // "" | "mock" | "http"
  certified: boolean; // true seulement pour un dispositif CE réel
  findings: DetectorFinding[];
  note?: string;
}

export function detectorConfigured(): boolean {
  const p = ENV.detectorProvider;
  if (p === "mock") return true;
  return p === "http" && !!ENV.detectorApiUrl && !!ENV.detectorApiKey;
}

/** Provider DÉMO : findings factices clairement étiquetés (jamais certifiés). */
function mockProvider(studyId: number, seriesId?: number): DetectorResult {
  return {
    enabled: true,
    provider: "mock",
    certified: false,
    note: "DÉMO (aucun dispositif certifié connecté) — résultats factices.",
    findings: [
      {
        app: "MOCK BoneView (démo)",
        label: "Fracture (exemple)",
        bodyPart: "—",
        confidence: 0.0,
        severity: "low",
        seriesId,
        ceClass: "—",
      },
    ],
  };
}

/**
 * Provider HTTP générique pour une plateforme CE. À ajuster à l'API de l'éditeur
 * (deepc/Incepto/Blackford). Hypothèse : on POST une référence d'étude + on reçoit
 * des findings normalisés. Le PHI ne doit transiter QUE vers un hébergement CH/UE.
 */
async function httpProvider(
  studyId: number,
  seriesId?: number
): Promise<DetectorResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(
      `${ENV.detectorApiUrl.replace(/\/$/, "")}/analyze`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.detectorApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({ studyId, seriesId }),
      }
    );
    if (!resp.ok) {
      return {
        enabled: true,
        provider: "http",
        certified: true,
        findings: [],
        note: `Détecteur indisponible (HTTP ${resp.status}).`,
      };
    }
    const data = (await resp.json()) as { findings?: unknown };
    const raw = Array.isArray(data.findings) ? data.findings : [];
    const findings: DetectorFinding[] = raw.map((f: any) => ({
      app: String(f.app ?? "Détecteur CE"),
      label: String(f.label ?? f.finding ?? "Anomalie"),
      bodyPart: f.bodyPart ?? f.body_part ?? undefined,
      confidence: typeof f.confidence === "number" ? f.confidence : undefined,
      severity: f.severity,
      seriesId: typeof f.seriesId === "number" ? f.seriesId : seriesId,
      sliceNumber:
        typeof f.sliceNumber === "number" ? f.sliceNumber : undefined,
      bbox: f.bbox,
      ceClass: f.ceClass ?? f.ce_class ?? undefined,
    }));
    return { enabled: true, provider: "http", certified: true, findings };
  } catch (e) {
    return {
      enabled: true,
      provider: "http",
      certified: true,
      findings: [],
      note: `Erreur détecteur : ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Point d'entrée : lance la détection certifiée sur une étude (selon ENV). */
export async function analyzeStudyWithDetector(
  studyId: number,
  seriesId?: number
): Promise<DetectorResult> {
  const p = ENV.detectorProvider;
  if (p === "mock") return mockProvider(studyId, seriesId);
  if (p === "http" && detectorConfigured())
    return httpProvider(studyId, seriesId);
  return {
    enabled: false,
    provider: p || "",
    certified: false,
    findings: [],
    note: "Aucun détecteur certifié configuré (DETECTOR_PROVIDER vide).",
  };
}
