import { ENV } from "../_core/env";

/**
 * Couche d'intégration des MOTEURS D'IA CERTIFIÉS (dispositifs médicaux CE /
 * FDA / Swissmedic) tiers — Gleamer BoneView, Koios DS Breast, Aidoc, CARPL,
 * Blackford, etc.
 *
 * POURQUOI : le compte rendu IA interne (Claude / Ollama vision) est une AIDE
 * NON CERTIFIÉE. Pour un diagnostic assisté sur lequel le médecin s'appuie
 * cliniquement, il faut un DISPOSITIF MÉDICAL CERTIFIÉ, spécialisé par
 * modalité/organe. Ces produits ne s'achètent pas « en code » : ils requièrent
 * un CONTRAT commercial + une connexion DICOM/DICOMweb (cloud ou on-prem) entre
 * le PACS (Orthanc, ici) et le moteur du fournisseur.
 *
 * CE MODULE fournit l'ARCHITECTURE prête à brancher : une interface commune et
 * un registre d'adaptateurs. Chaque fournisseur est ACTIVÉ par sa variable
 * d'environnement (URL + clé) et reste INACTIF tant qu'aucun contrat n'est
 * signé / aucune clé fournie. Aucun appel réseau n'est fait sans configuration.
 *
 * ⚠️ CONFORMITÉ : la plupart de ces moteurs sont hébergés en cloud (souvent
 * hors Suisse). Envoyer du PHI vers eux exige un DPA + enregistrement Swissmedic
 * + base légale nLPD, exactement comme pour Claude. Le flag par fournisseur
 * `phiConsent` garde l'envoi tant que le consentement n'est pas documenté.
 */

// Modalités/régions couvertes par un moteur (pour le routage automatique).
export type AiModality = "XR" | "CT" | "MR" | "US" | "MG" | "PT" | "NM";

export interface CertifiedFinding {
  // Code structuré quand le moteur en fournit un (BI-RADS, Lung-RADS, etc.).
  category?: string;
  label: string; // libellé lisible (ex. « Fracture radius distal »)
  confidence?: number; // 0..1 si fourni
  bbox?: { x1: number; y1: number; x2: number; y2: number }; // fractions 0..1
  sliceNumber?: number; // coupe concernée (CT/MR)
}

export interface CertifiedResult {
  provider: string; // nom du moteur (ex. « Gleamer BoneView »)
  certified: boolean; // true = dispositif médical certifié
  regulatory: string; // ex. « CE (MDR, Class IIb) ; FDA 510(k) »
  modality: AiModality;
  findings: CertifiedFinding[];
  structuredReport?: string; // CR structuré renvoyé par le moteur, si fourni
  rawRef?: string; // identifiant de l'analyse côté fournisseur (traçabilité)
  disclaimer: string; // mention obligatoire (validation médecin)
}

export interface CertifiedAiInput {
  studyId: number;
  seriesId?: number;
  modality: AiModality;
  // Référence DICOM (StudyInstanceUID) que le fournisseur ira chercher via
  // DICOMweb (QIDO/WADO) ou que MediView pousse via STOW-RS.
  studyInstanceUid: string;
}

/** Un adaptateur de fournisseur certifié. Configuré ⇒ actif. */
export interface CertifiedAiProvider {
  name: string;
  regulatory: string;
  modalities: AiModality[];
  // Activé seulement si la config (URL + clé) est présente.
  isConfigured(): boolean;
  // Le consentement PHI documenté est-il activé pour CE fournisseur ?
  hasPhiConsent(): boolean;
  analyze(input: CertifiedAiInput): Promise<CertifiedResult>;
}

const DISCLAIMER =
  "Résultat d'un dispositif d'aide au diagnostic. À relire, valider et signer " +
  "par le médecin. Ne remplace pas l'interprétation médicale.";

/**
 * Adaptateur GÉNÉRIQUE DICOMweb : couvre le mode d'intégration commun à la
 * quasi-totalité de ces moteurs (Gleamer, Koios, Aidoc via leur passerelle) —
 * on transmet la référence d'étude, le moteur va chercher les images via
 * DICOMweb et renvoie des findings structurés. Le mapping de la réponse est
 * spécialisé par `parseResponse` dans chaque sous-adaptateur.
 */
abstract class DicomwebProvider implements CertifiedAiProvider {
  abstract name: string;
  abstract regulatory: string;
  abstract modalities: AiModality[];
  protected abstract baseUrlEnv?: string;
  protected abstract apiKeyEnv?: string;
  protected abstract phiConsentEnv: boolean;

  isConfigured(): boolean {
    return !!this.baseUrlEnv && !!this.apiKeyEnv;
  }
  hasPhiConsent(): boolean {
    return this.phiConsentEnv;
  }

  protected abstract parseResponse(
    data: any,
    modality: AiModality
  ): CertifiedFinding[];

  async analyze(input: CertifiedAiInput): Promise<CertifiedResult> {
    if (!this.isConfigured()) {
      throw new Error(`${this.name} non configuré (URL/clé absentes)`);
    }
    if (!this.hasPhiConsent()) {
      throw new Error(
        `${this.name} : consentement PHI non activé (nLPD/DPA requis avant envoi cloud)`
      );
    }
    const resp = await fetch(`${this.baseUrlEnv}/v1/analyze`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKeyEnv}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        study_instance_uid: input.studyInstanceUid,
        modality: input.modality,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${this.name} HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    return {
      provider: this.name,
      certified: true,
      regulatory: this.regulatory,
      modality: input.modality,
      findings: this.parseResponse(data, input.modality),
      structuredReport: data?.report ?? data?.structured_report ?? undefined,
      rawRef: data?.analysis_id ?? data?.id ?? undefined,
      disclaimer: DISCLAIMER,
    };
  }
}

// --- Gleamer BoneView : radio (fractures, MSK) — CE -------------------------
class GleamerBoneView extends DicomwebProvider {
  name = "Gleamer BoneView";
  regulatory = "CE (MDR)";
  modalities: AiModality[] = ["XR"];
  protected baseUrlEnv = ENV.gleamerUrl;
  protected apiKeyEnv = ENV.gleamerApiKey;
  protected phiConsentEnv = ENV.gleamerPhiConsent;
  protected parseResponse(data: any): CertifiedFinding[] {
    const out: CertifiedFinding[] = [];
    for (const f of data?.findings ?? []) {
      out.push({
        label: f.label ?? f.finding ?? "anomalie",
        confidence: f.confidence ?? f.score,
        bbox: f.bbox,
        category: f.region,
      });
    }
    return out;
  }
}

// --- Koios DS Breast : échographie mammaire (BI-RADS) — CE + FDA ------------
class KoiosDsBreast extends DicomwebProvider {
  name = "Koios DS Breast";
  regulatory = "CE ; FDA 510(k)";
  modalities: AiModality[] = ["US", "MG"];
  protected baseUrlEnv = ENV.koiosUrl;
  protected apiKeyEnv = ENV.koiosApiKey;
  protected phiConsentEnv = ENV.koiosPhiConsent;
  protected parseResponse(data: any): CertifiedFinding[] {
    const out: CertifiedFinding[] = [];
    for (const n of data?.nodules ?? data?.findings ?? []) {
      out.push({
        category: n.birads ?? n.bi_rads ?? n.category, // BI-RADS
        label: n.assessment ?? n.descriptor ?? "lésion",
        confidence: n.malignancy_risk ?? n.confidence,
        bbox: n.bbox,
      });
    }
    return out;
  }
}

// --- Aidoc : CT/urgences (AVC, EP, hémorragie) — CE + FDA -------------------
class Aidoc extends DicomwebProvider {
  name = "Aidoc";
  regulatory = "CE (MDR) ; FDA 510(k)";
  modalities: AiModality[] = ["CT"];
  protected baseUrlEnv = ENV.aidocUrl;
  protected apiKeyEnv = ENV.aidocApiKey;
  protected phiConsentEnv = ENV.aidocPhiConsent;
  protected parseResponse(data: any): CertifiedFinding[] {
    const out: CertifiedFinding[] = [];
    for (const f of data?.findings ?? []) {
      out.push({
        label: f.pathology ?? f.label ?? "finding",
        confidence: f.confidence,
        category: f.severity,
        sliceNumber: f.slice ?? f.key_slice,
      });
    }
    return out;
  }
}

// --- CARPL.ai : MARKETPLACE vendor-neutral (1 intégration → N modèles) ------
// Recommandé pour DÉMARRER : permet de tester/comparer plusieurs moteurs sur
// ses propres images avant de s'engager. Couvre toutes les modalités via les
// modèles qu'on y active.
class Carpl extends DicomwebProvider {
  name = "CARPL.ai (marketplace)";
  regulatory = "CE ; agrège des modèles certifiés";
  modalities: AiModality[] = ["XR", "CT", "MR", "US", "MG", "PT", "NM"];
  protected baseUrlEnv = ENV.carplUrl;
  protected apiKeyEnv = ENV.carplApiKey;
  protected phiConsentEnv = ENV.carplPhiConsent;
  protected parseResponse(data: any): CertifiedFinding[] {
    const out: CertifiedFinding[] = [];
    for (const f of data?.results ?? data?.findings ?? []) {
      out.push({
        label: f.label ?? f.finding ?? "finding",
        confidence: f.confidence ?? f.score,
        category: f.model ?? f.category,
        bbox: f.bbox,
        sliceNumber: f.slice,
      });
    }
    return out;
  }
}

// --- Blackford : PLATEFORME (94+ apps multi-vendeurs) — CE ------------------
class Blackford extends DicomwebProvider {
  name = "Blackford Platform";
  regulatory = "CE ; agrège 90+ apps certifiées";
  modalities: AiModality[] = ["XR", "CT", "MR", "US", "MG", "PT", "NM"];
  protected baseUrlEnv = ENV.blackfordUrl;
  protected apiKeyEnv = ENV.blackfordApiKey;
  protected phiConsentEnv = ENV.blackfordPhiConsent;
  protected parseResponse(data: any): CertifiedFinding[] {
    const out: CertifiedFinding[] = [];
    for (const f of data?.findings ?? []) {
      out.push({
        label: f.label ?? "finding",
        confidence: f.confidence,
        category: f.app ?? f.category,
        bbox: f.bbox,
        sliceNumber: f.slice,
      });
    }
    return out;
  }
}

const ALL_PROVIDERS: CertifiedAiProvider[] = [
  new Carpl(),
  new Blackford(),
  new GleamerBoneView(),
  new KoiosDsBreast(),
  new Aidoc(),
];

/** Fournisseurs RÉELLEMENT configurés (clé présente). */
export function configuredProviders(): CertifiedAiProvider[] {
  return ALL_PROVIDERS.filter(p => p.isConfigured());
}

/**
 * Choisit les fournisseurs configurés capables de traiter cette modalité.
 * Priorité aux marketplaces (couverture large) puis aux moteurs spécialisés.
 */
export function providersForModality(
  modality: AiModality
): CertifiedAiProvider[] {
  return configuredProviders().filter(p => p.modalities.includes(modality));
}

/** Inventaire (pour l'UI) : ce qui est branché vs disponible mais non configuré. */
export function certifiedAiInventory(): {
  name: string;
  regulatory: string;
  modalities: AiModality[];
  configured: boolean;
  phiConsent: boolean;
}[] {
  return ALL_PROVIDERS.map(p => ({
    name: p.name,
    regulatory: p.regulatory,
    modalities: p.modalities,
    configured: p.isConfigured(),
    phiConsent: p.hasPhiConsent(),
  }));
}

/**
 * Lance l'analyse certifiée sur le 1er fournisseur configuré pour la modalité.
 * Renvoie null si AUCUN fournisseur certifié n'est branché (cas par défaut tant
 * qu'aucun contrat n'est signé) — l'appelant retombe alors sur l'aide interne.
 */
export async function runCertifiedAnalysis(
  input: CertifiedAiInput
): Promise<CertifiedResult | null> {
  const candidates = providersForModality(input.modality).filter(p =>
    p.hasPhiConsent()
  );
  if (candidates.length === 0) return null;
  return candidates[0].analyze(input);
}
