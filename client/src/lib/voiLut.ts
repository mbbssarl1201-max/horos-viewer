// Application de la VOI LUT (Values Of Interest LUT) — menu « Use VOI LUT ».
//
// La VOI LUT transforme une valeur de pixel déjà passée par la Modality LUT
// (rescale, c.-à-d. en HU pour un CT) en une valeur d'AFFICHAGE normalisée
// dans [0,1] (0 = noir, 1 = blanc), selon un « window center » (WC) et une
// « window width » (WW). Le viewer mappe ensuite [0,1] vers les niveaux de
// gris affichables.
//
// DICOM (PS3.3 C.11.2 « VOI LUT Module ») définit deux fonctions explicites
// via le tag VOI LUT Function (0028,1056) :
//   • LINEAR  : fenêtre linéaire classique (window/level).
//   • SIGMOID : fenêtre logistique (rendu « doux » des bords de fenêtre).
//
// Module 100 % PUR : aucune dépendance Cornerstone / DOM / I/O. On ne
// manipule que des nombres → entièrement testable hors navigateur.

/** Fonctions VOI LUT supportées (tag 0028,1056). */
export type VoiLutFunction = "LINEAR" | "SIGMOID";

/**
 * Borne une valeur dans [0,1]. `NaN` → 0 (choix sûr : on n'affiche pas de
 * pixel « indéfini » comme blanc).
 */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * VOI LUT LINÉAIRE (DICOM PS3.3 C.11.2.1.2, « LINEAR »).
 *
 * Formule normative (sortie ramenée à [0,1] au lieu de [ymin,ymax]) :
 *   si      x ≤ wc − (ww − 1) / 2   → 0
 *   sinon si x >  wc + (ww − 1) / 2  → 1
 *   sinon   → ((x − (wc − 0.5)) / (ww − 1)) + 0.5
 *
 * `ww` est forcée à ≥ 1 (une largeur nulle ou négative n'a pas de sens) ; avec
 * ww = 1 la fonction devient un simple seuil binaire centré sur wc.
 *
 * @param value valeur du pixel (post-rescale, p.ex. HU)
 * @param wc    window center (niveau)
 * @param ww    window width  (fenêtre, ≥ 1)
 * @returns valeur d'affichage normalisée dans [0,1]
 */
export function applyLinearVoi(value: number, wc: number, ww: number): number {
  const width = ww < 1 ? 1 : ww;
  const below = wc - (width - 1) / 2;
  const above = wc + (width - 1) / 2;
  if (value <= below) return 0;
  if (value > above) return 1;
  return clamp01((value - (wc - 0.5)) / (width - 1) + 0.5);
}

/**
 * VOI LUT SIGMOÏDE (DICOM PS3.3 C.11.2.1.3, « SIGMOID »).
 *
 * Formule normative (sortie déjà dans [0,1[) :
 *   y(x) = 1 / (1 + exp(−4 · (x − wc) / ww))
 *
 * Le facteur 4 est imposé par la norme : il aligne la pente au centre de la
 * sigmoïde sur celle d'une fenêtre linéaire de même WW. Contrairement à la
 * version linéaire, la sigmoïde n'a pas de bornes franches : elle approche 0
 * et 1 asymptotiquement.
 *
 * `ww` est forcée à ≥ une valeur strictement positive minuscule pour éviter la
 * division par zéro (ww → 0 ⇒ seuil dur en wc).
 *
 * @param value valeur du pixel (post-rescale)
 * @param wc    window center
 * @param ww    window width (> 0)
 * @returns valeur d'affichage normalisée dans [0,1]
 */
export function applySigmoidVoi(value: number, wc: number, ww: number): number {
  // ww ≤ 0 → seuil dur en wc (la sigmoïde dégénère en marche de Heaviside).
  if (ww <= 0) {
    if (value < wc) return 0;
    if (value > wc) return 1;
    return 0.5;
  }
  return clamp01(1 / (1 + Math.exp((-4 * (value - wc)) / ww)));
}

/**
 * Précalcule une VOI LUT sous forme de table échantillonnée sur la fenêtre, de
 * `steps` entrées, chaque entrée dans [0,1]. Utile pour appliquer la fenêtre en
 * une passe O(1) par pixel (lookup) côté rendu.
 *
 * L'échantillonnage couvre l'intervalle [wc − ww/2, wc + ww/2] (la fenêtre
 * d'intérêt) ; l'entrée i correspond à la valeur :
 *   x_i = (wc − ww/2) + (i / (steps − 1)) · ww
 * de sorte que la table[0] = bord bas de fenêtre et table[steps−1] = bord haut.
 *
 * @param wc    window center
 * @param ww    window width
 * @param fn    fonction VOI (« LINEAR » | « SIGMOID »)
 * @param steps nombre d'entrées de la table (≥ 2, défaut 256)
 * @returns Float32Array de `steps` valeurs dans [0,1]
 */
export function voiToLut(
  wc: number,
  ww: number,
  fn: VoiLutFunction,
  steps = 256
): Float32Array {
  // Au moins 2 entrées pour définir une rampe ; on tronque vers l'entier.
  const n = Math.max(2, Math.floor(steps));
  const lut = new Float32Array(n);
  const apply = fn === "SIGMOID" ? applySigmoidVoi : applyLinearVoi;

  // Largeur d'échantillonnage : si ww ≤ 0, la fenêtre est dégénérée — on
  // échantillonne alors une plage symétrique minimale autour de wc pour que la
  // table reste exploitable (sinon toutes les entrées tomberaient sur wc).
  const span = ww > 0 ? ww : 1;
  const start = wc - span / 2;

  for (let i = 0; i < n; i++) {
    const x = start + (i / (n - 1)) * span;
    lut[i] = apply(x, wc, ww);
  }
  return lut;
}
