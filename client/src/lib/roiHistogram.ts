/**
 * Histogramme et statistiques des valeurs de pixels dans une ROI (région
 * d'intérêt) — menu « Histogram of Selected ROI » d'Horos.
 *
 * Fonctions PURES et déterministes : aucune dépendance Cornerstone / DOM / I/O.
 * On ne manipule que des tableaux de nombres (les valeurs de pixels déjà
 * extraites de la ROI, par ex. en unités Hounsfield après rescale DICOM).
 *
 * ── Histogramme ──────────────────────────────────────────────────────────────
 * On répartit les valeurs sur `binCount` intervalles (« bins ») de largeur
 * égale entre `min` et `max`. Le dernier bin est FERMÉ à droite : la borne
 * supérieure `max` tombe dans le dernier bin (et non hors plage). Les autres
 * bins sont semi-ouverts [edge_i, edge_{i+1}[. Les valeurs hors [min,max] sont
 * ignorées du comptage. Les valeurs non finies (NaN/Inf) sont écartées partout.
 *
 * ── Robustesse ──────────────────────────────────────────────────────────────
 * Aucune exception : entrées vides / dégénérées renvoient des résultats neutres
 * cohérents (count 0, bins à zéro). C'est un choix de sûreté : l'appelant
 * affiche un histogramme vide plutôt que de planter sur une ROI sans pixel.
 */

/** Résultat d'un calcul d'histogramme. */
export interface HistogramResult {
  /** Effectif de chaque bin (longueur = binCount). */
  bins: number[];
  /** Bornes des bins (longueur = binCount + 1, croissantes). */
  binEdges: number[];
  /** Borne inférieure de la plage prise en compte. */
  min: number;
  /** Borne supérieure de la plage prise en compte. */
  max: number;
  /** Nombre de valeurs effectivement comptées (dans [min,max], finies). */
  count: number;
}

/** Statistiques descriptives d'un ensemble de valeurs. */
export interface HistogramStats {
  /** Moyenne arithmétique. */
  mean: number;
  /** Écart-type de population (diviseur N). */
  std: number;
  /** Valeur minimale. */
  min: number;
  /** Valeur maximale. */
  max: number;
  /** Médiane (interpolée entre les deux centraux si effectif pair). */
  median: number;
}

/** Ne conserve que les nombres finis (écarte NaN / ±Infinity / non-number). */
function finiteOnly(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Calcule l'histogramme des `values` sur `binCount` bins entre `min` et `max`.
 *
 * Paramètres :
 *   • `binCount` (défaut 256, comme la barre d'histogramme d'Horos) : nombre de
 *     bins. Toute valeur < 1 ou non finie est ramenée à 1.
 *   • `min` / `max` : plage de l'histogramme. Si absents, on prend le min/max
 *     des valeurs finies. Si `min > max`, les bornes sont échangées.
 *
 * Comportements de bord :
 *   • Aucune valeur finie → bins à zéro, count 0, plage [0,0] (ou [min,max] si
 *     fournis) avec des edges cohérents.
 *   • Plage dégénérée (min === max) → un unique intervalle [min,max] ; toutes
 *     les valeurs égales à cette borne y sont comptées.
 */
export function computeHistogram(
  values: readonly number[],
  binCount = 256,
  min?: number,
  max?: number
): HistogramResult {
  const finite = finiteOnly(values);

  // Normalisation du nombre de bins.
  let nBins = Math.floor(binCount);
  if (!Number.isFinite(nBins) || nBins < 1) nBins = 1;

  // Détermination de la plage [lo, hi].
  let lo: number;
  let hi: number;
  const minGiven = typeof min === "number" && Number.isFinite(min);
  const maxGiven = typeof max === "number" && Number.isFinite(max);

  if (minGiven && maxGiven) {
    lo = min as number;
    hi = max as number;
  } else if (finite.length > 0) {
    let dataMin = finite[0];
    let dataMax = finite[0];
    for (const v of finite) {
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
    lo = minGiven ? (min as number) : dataMin;
    hi = maxGiven ? (max as number) : dataMax;
  } else {
    // Aucune valeur finie et bornes incomplètes → plage neutre.
    lo = minGiven ? (min as number) : 0;
    hi = maxGiven ? (max as number) : 0;
  }

  // Bornes inversées → on remet dans l'ordre.
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }

  // Bornes des bins (linéaires de lo à hi).
  const binEdges = new Array<number>(nBins + 1);
  const span = hi - lo;
  for (let i = 0; i <= nBins; i += 1) {
    binEdges[i] = lo + (span * i) / nBins;
  }
  // Force exactement les extrémités (évite la dérive d'arrondi).
  binEdges[0] = lo;
  binEdges[nBins] = hi;

  const bins = new Array<number>(nBins).fill(0);
  let count = 0;

  for (const v of finite) {
    if (v < lo || v > hi) continue; // hors plage
    let idx: number;
    if (span <= 0) {
      // Plage dégénérée : tout dans l'unique premier bin.
      idx = 0;
    } else {
      idx = Math.floor(((v - lo) / span) * nBins);
      // Borne haute fermée : v === hi tombe dans le dernier bin.
      if (idx >= nBins) idx = nBins - 1;
      if (idx < 0) idx = 0;
    }
    bins[idx] += 1;
    count += 1;
  }

  return { bins, binEdges, min: lo, max: hi, count };
}

/**
 * Statistiques descriptives des `values` (valeurs non finies écartées).
 *
 * Cas dégénérés : tableau vide (ou sans valeur finie) → tous les champs à 0.
 * `std` est l'écart-type de population (diviseur N), cohérent avec une ROI
 * exhaustivement échantillonnée. `median` interpole la moyenne des deux valeurs
 * centrales pour un effectif pair.
 */
export function histogramStats(values: readonly number[]): HistogramStats {
  const finite = finiteOnly(values);
  const n = finite.length;
  if (n === 0) {
    return { mean: 0, std: 0, min: 0, max: 0, median: 0 };
  }

  let sum = 0;
  let lo = finite[0];
  let hi = finite[0];
  for (const v of finite) {
    sum += v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mean = sum / n;

  let varSum = 0;
  for (const v of finite) {
    const d = v - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);

  // Médiane sur une copie triée (ne mute pas l'entrée).
  const sorted = finite.slice().sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return { mean, std, min: lo, max: hi, median };
}
