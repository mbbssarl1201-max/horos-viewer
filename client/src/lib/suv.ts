/**
 * Calcul du facteur SUV (Standardized Uptake Value) pondéré par le poids
 * corporel (« body-weight SUV »), à partir des métadonnées DICOM d'une série PET.
 *
 * Fonctions PURES et testables : aucune dépendance Cornerstone / DOM. On ne
 * manipule que des nombres et des chaînes de tags DICOM déjà extraites.
 *
 * ── Rappel du calcul SUV (body weight) ──────────────────────────────────────
 *   SUV(voxel) = activité_concentration(voxel) [Bq/mL]
 *                ──────────────────────────────────────────────
 *                (dose_injectée_décroissue [Bq]) / poids [g]
 *
 * où :
 *   • dose_injectée (RadionuclideTotalDose, 0018,1074) est en Bq, mesurée à
 *     l'instant d'injection (RadiopharmaceuticalStartTime, 0018,1072).
 *   • la dose DÉCROÎT entre l'injection et l'acquisition (SeriesTime, 0008,0031,
 *     repli AcquisitionTime 0008,0032) selon la demi-vie du radionucléide
 *     (RadionuclideHalfLife, 0018,1075, en secondes) :
 *        dose_décroissue = dose_injectée · 2^(-Δt / demi_vie)
 *     avec Δt = (temps_acquisition − temps_injection) en secondes.
 *   • poids du patient (PatientWeight, 0010,1030) en kg → ×1000 pour des grammes
 *     (1 g de tissu ≈ 1 mL → la concentration reste en Bq/mL).
 *
 * On expose un FACTEUR : SUV = pixel_value × suvFactor. Le pixel PET, une fois
 * la « Rescale » DICOM appliquée par le viewer, est en Bq/mL (unité BQML, cas
 * standard). Le facteur vaut alors :
 *        suvFactor = poids_g / dose_décroissue
 *
 * ── Robustesse ──────────────────────────────────────────────────────────────
 * Toute donnée manquante / non parsable rend `null` (pas d'exception, pas de
 * NaN propagé). L'appelant affiche alors « SUV indisponible » plutôt qu'une
 * valeur fausse. C'est un choix de sûreté clinique : ne JAMAIS afficher un SUV
 * que l'on ne peut pas justifier par les tags.
 */

/** Tags DICOM bruts nécessaires au calcul (chaînes telles que lues du dataset). */
export interface SuvMetadata {
  /** Poids du patient en kg (PatientWeight, 0010,1030). */
  patientWeightKg?: number | string | null;
  /** Dose totale injectée en Bq (RadionuclideTotalDose, 0018,1074). */
  radionuclideTotalDoseBq?: number | string | null;
  /** Demi-vie du radionucléide en secondes (RadionuclideHalfLife, 0018,1075). */
  radionuclideHalfLifeSec?: number | string | null;
  /**
   * Heure de début d'injection (RadiopharmaceuticalStartTime, 0018,1072),
   * format DICOM TM `HHMMSS.FFFFFF`.
   */
  radiopharmaceuticalStartTime?: string | null;
  /**
   * Heure de référence de l'acquisition : SeriesTime (0008,0031), avec repli
   * sur AcquisitionTime (0008,0032), format DICOM TM `HHMMSS.FFFFFF`.
   */
  seriesTime?: string | null;
  /** Unités des pixels (Units, 0054,1001). « BQML » attendu pour un SUV fiable. */
  units?: string | null;
}

/** Résultat du calcul : facteur + diagnostic lisible. */
export interface SuvFactorResult {
  /** Facteur multiplicatif : SUV = pixel_value × factor. `null` si incalculable. */
  factor: number | null;
  /** Raison de l'échec (pour journal / UI), `null` si succès. */
  reason: string | null;
  /** Δt injection→acquisition en secondes (diagnostic), `null` si indisponible. */
  decayTimeSec: number | null;
  /** Dose décroissue à l'acquisition en Bq (diagnostic), `null` si indisponible. */
  decayedDoseBq: number | null;
}

/** Convertit une valeur (number | string DICOM) en nombre fini, ou `null`. */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse une heure DICOM TM `HHMMSS.FFFFFF` (les `:` éventuels sont tolérés) en
 * secondes depuis minuit. Renvoie `null` si le format est inexploitable.
 *
 * On reste tolérant : `HH`, `HHMM`, `HHMMSS`, fraction optionnelle. Heures hors
 * [0,24[ ou champs hors borne → `null`.
 */
export function parseDicomTimeToSeconds(tm: unknown): number | null {
  if (tm === null || tm === undefined) return null;
  const raw = String(tm).trim().replace(/:/g, "");
  if (!raw) return null;
  // HHMMSS(.ffffff) — on exige au moins HH.
  const m = /^(\d{2})(\d{2})?(\d{2})?(\.\d+)?$/.exec(raw);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const ss = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  const frac = m[4] !== undefined ? parseFloat(m[4]) : 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 60) return null;
  return hh * 3600 + mm * 60 + ss + frac;
}

/**
 * Δt (secondes) entre deux heures DICOM TM (acquisition − injection). Gère le
 * passage de minuit : si l'acquisition est « avant » l'injection sur 24 h, on
 * suppose que la journée a tourné (+86400 s). Renvoie `null` si l'une des heures
 * est inexploitable ou si Δt résultant est négatif/aberrant (> 24 h).
 */
export function decayTimeSeconds(
  injectionTime: unknown,
  acquisitionTime: unknown
): number | null {
  const inj = parseDicomTimeToSeconds(injectionTime);
  const acq = parseDicomTimeToSeconds(acquisitionTime);
  if (inj === null || acq === null) return null;
  let dt = acq - inj;
  if (dt < 0) dt += 86400; // passage de minuit
  if (dt < 0 || dt > 86400) return null;
  return dt;
}

/**
 * Calcule le facteur SUV (body weight). Voir l'en-tête du module pour la
 * formule. Toute donnée manquante / incohérente → `factor: null` + `reason`.
 *
 * Conditions de validité :
 *   • poids > 0
 *   • dose injectée > 0
 *   • demi-vie > 0
 *   • heures injection & acquisition parsables (Δt ≥ 0)
 *   • unités « BQML » (sinon le pixel n'est pas en Bq/mL → SUV non garanti) ;
 *     on calcule quand même le facteur mais on signale l'unité dans `reason`
 *     UNIQUEMENT si elle est présente et différente — si `units` est absent on
 *     suppose BQML (cas le plus courant) et on n'avertit pas.
 */
export function computeSuvFactor(meta: SuvMetadata): SuvFactorResult {
  const empty: SuvFactorResult = {
    factor: null,
    reason: null,
    decayTimeSec: null,
    decayedDoseBq: null,
  };

  const weightKg = toFiniteNumber(meta.patientWeightKg);
  if (weightKg === null || weightKg <= 0) {
    return { ...empty, reason: "Poids patient absent ou invalide" };
  }

  const doseBq = toFiniteNumber(meta.radionuclideTotalDoseBq);
  if (doseBq === null || doseBq <= 0) {
    return { ...empty, reason: "Dose injectée absente ou invalide" };
  }

  const halfLife = toFiniteNumber(meta.radionuclideHalfLifeSec);
  if (halfLife === null || halfLife <= 0) {
    return { ...empty, reason: "Demi-vie absente ou invalide" };
  }

  const dt = decayTimeSeconds(
    meta.radiopharmaceuticalStartTime,
    meta.seriesTime
  );
  if (dt === null) {
    return { ...empty, reason: "Temps injection/acquisition indisponible" };
  }

  // Décroissance radioactive : dose à l'acquisition.
  const decayedDose = doseBq * Math.pow(2, -dt / halfLife);
  if (!Number.isFinite(decayedDose) || decayedDose <= 0) {
    return { ...empty, reason: "Dose décroissue invalide" };
  }

  // poids g / dose décroissue (Bq) → (g·mL⁻¹? ) tel que SUV = pixel(Bq/mL)×factor.
  const weightG = weightKg * 1000;
  const factor = weightG / decayedDose;
  if (!Number.isFinite(factor) || factor <= 0) {
    return { ...empty, reason: "Facteur SUV invalide" };
  }

  // Avertissement d'unité (non bloquant) : seulement si présent ET ≠ BQML.
  let reason: string | null = null;
  if (meta.units && String(meta.units).trim().toUpperCase() !== "BQML") {
    reason = `Unités pixel « ${meta.units} » ≠ BQML : SUV approximatif`;
  }

  return {
    factor,
    reason,
    decayTimeSec: dt,
    decayedDoseBq: decayedDose,
  };
}

/**
 * Interface minimale d'un dataset dicom-parser (sous-ensemble utilisé). Permet
 * de tester `extractSuvMetadataFromDataset` avec un faux dataset sans dépendre
 * de dicom-parser.
 */
export interface DicomDatasetLike {
  string(tag: string, index?: number): string | undefined;
  floatString?(tag: string, index?: number): number | undefined;
  elements?: Record<string, { items?: { dataSet: DicomDatasetLike }[] }>;
}

/**
 * Extrait les tags SUV d'un dataset DICOM (dicom-parser) d'une coupe PET, vers
 * la forme `SuvMetadata` consommée par `computeSuvFactor`. PUR au sens où il ne
 * dépend que de l'interface `DicomDatasetLike` (testable avec un mock).
 *
 * Tags lus :
 *   • PatientWeight                 (0010,1030)
 *   • SeriesTime                    (0008,0031) ; repli AcquisitionTime (0008,0032)
 *   • Units                         (0054,1001)
 *   • RadiopharmaceuticalInformationSequence (0054,0016) → 1er item :
 *       - RadionuclideTotalDose         (0018,1074)
 *       - RadionuclideHalfLife          (0018,1075)
 *       - RadiopharmaceuticalStartTime  (0018,1072)
 *
 * Toute absence laisse le champ à `undefined` → `computeSuvFactor` rendra alors
 * un facteur `null` avec une raison. Aucune exception propagée.
 */
export function extractSuvMetadataFromDataset(
  ds: DicomDatasetLike | null | undefined
): SuvMetadata {
  const out: SuvMetadata = {};
  if (!ds) return out;
  const num = (tag: string, src: DicomDatasetLike = ds): number | undefined => {
    try {
      if (typeof src.floatString === "function") {
        const v = src.floatString(tag);
        if (v !== undefined && Number.isFinite(v)) return v;
      }
      const s = src.string(tag);
      if (s === undefined) return undefined;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const str = (tag: string, src: DicomDatasetLike = ds): string | undefined => {
    try {
      return src.string(tag);
    } catch {
      return undefined;
    }
  };

  out.patientWeightKg = num("x00101030");
  out.seriesTime = str("x00080031") ?? str("x00080032");
  out.units = str("x00541001");

  // RadiopharmaceuticalInformationSequence → premier item.
  try {
    const seq = ds.elements?.["x00540016"];
    const item = seq?.items?.[0]?.dataSet;
    if (item) {
      out.radionuclideTotalDoseBq = num("x00181074", item);
      out.radionuclideHalfLifeSec = num("x00181075", item);
      out.radiopharmaceuticalStartTime = str("x00181072", item);
    }
  } catch {
    // séquence absente / malformée → champs laissés indéfinis
  }

  return out;
}
