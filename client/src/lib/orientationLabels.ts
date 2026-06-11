// Lettres d'orientation anatomique aux bords de l'image (A/P/L/R/H/F).
//
// Comme Horos / OsiriX, on affiche aux quatre bords du viewport la direction
// anatomique vers laquelle « pointe » ce bord, exprimée en lettres patient :
//   • R / L : Right / Left (axe X patient)
//   • A / P : Anterior / Posterior (axe Y patient)
//   • H / F : Head / Foot (axe Z patient, « Superior / Inferior »)
//
// Une direction d'écran peut combiner plusieurs axes (coupe oblique) : on
// compose alors les lettres dominantes dans l'ordre décroissant de contribution
// (ex. « AL », « FPR »), exactement comme OsiriX.
//
// ── Repère DICOM ──────────────────────────────────────────────────────────────
// ImageOrientationPatient (0020,0037) donne 6 cosinus directeurs : les 3
// premiers = direction de la LIGNE (axe X écran, vers la droite de l'image), les
// 3 suivants = direction de la COLONNE (axe Y écran, vers le BAS de l'image),
// tous exprimés dans le repère patient LPS (X→Left, Y→Posterior, Z→Superior).
//
// Algorithme (OsiriX, fonction `setOrientation`) : pour un vecteur direction
// d'écran v = (x,y,z) dans le repère patient, on parcourt les composantes par
// magnitude décroissante ; chaque composante au-dessus d'un seuil ajoute une
// lettre — signe positif/négatif choisissant la lettre de l'axe.
//
// Code PUR : pas de DOM, pas de Cornerstone, déterministe et testable hors
// navigateur.

/** Vecteur de 3 cosinus directeurs dans le repère patient LPS. */
export type Vec3 = readonly [number, number, number];

/** Lettres d'orientation aux quatre bords du viewport. */
export interface EdgeLabels {
  /** Bord supérieur de l'image. */
  top: string;
  /** Bord inférieur de l'image. */
  bottom: string;
  /** Bord gauche de l'image. */
  left: string;
  /** Bord droit de l'image. */
  right: string;
}

/**
 * Seuil minimal de contribution (cosinus) pour qu'un axe ajoute sa lettre.
 * OsiriX utilise 0,0001 : on retient toute composante non négligeable mais on
 * écarte le bruit numérique pur. Choisi assez bas pour rester fidèle aux
 * coupes obliques, assez haut pour ignorer les arrondis.
 */
const AXIS_THRESHOLD = 0.0001;

/**
 * Convertit une valeur (number | string DICOM) en nombre fini, ou `null`.
 * Tolère les chaînes du dataset (DS) et les espaces.
 */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Donne la lettre d'orientation patient pour une composante d'axe donnée.
 *
 * @param axis  0 = X (R/L), 1 = Y (A/P), 2 = Z (F/H)
 * @param value composante signée du vecteur sur cet axe (repère LPS)
 *
 * En LPS, X positif pointe vers Left, Y positif vers Posterior, Z positif vers
 * Superior (Head). On renvoie donc la lettre correspondant au SIGNE de `value`.
 */
function axisLetter(axis: 0 | 1 | 2, value: number): string {
  switch (axis) {
    case 0:
      return value < 0 ? "R" : "L"; // X<0 → Right, X>0 → Left
    case 1:
      return value < 0 ? "A" : "P"; // Y<0 → Anterior, Y>0 → Posterior
    case 2:
      return value < 0 ? "F" : "H"; // Z<0 → Foot, Z>0 → Head (Superior)
  }
}

/**
 * Compose les lettres d'orientation d'un vecteur direction (repère patient LPS),
 * dans l'ordre décroissant de magnitude des composantes — façon OsiriX.
 *
 * Renvoie une chaîne vide si le vecteur est nul / sous le seuil (cas dégénéré).
 */
export function orientationStringForVector(v: Vec3): string {
  // On indexe (axe, valeur, |valeur|) puis on trie par magnitude décroissante.
  const axes: { axis: 0 | 1 | 2; value: number; mag: number }[] = [
    { axis: 0, value: v[0], mag: Math.abs(v[0]) },
    { axis: 1, value: v[1], mag: Math.abs(v[1]) },
    { axis: 2, value: v[2], mag: Math.abs(v[2]) },
  ];
  axes.sort((a, b) => b.mag - a.mag);

  let out = "";
  for (const a of axes) {
    if (a.mag <= AXIS_THRESHOLD) continue;
    out += axisLetter(a.axis, a.value);
  }
  return out;
}

/** Négatif terme à terme d'un vecteur. */
function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

/**
 * Calcule les lettres d'orientation aux quatre bords à partir de
 * ImageOrientationPatient (6 cosinus : 3 pour la ligne/axe X écran « vers la
 * droite », 3 pour la colonne/axe Y écran « vers le bas »).
 *
 * Conventions :
 *   • `right`  = direction de la ligne (rowDir) telle quelle ;
 *   • `left`   = direction opposée (−rowDir) ;
 *   • `bottom` = direction de la colonne (colDir) telle quelle (colonne pointe
 *                vers le bas de l'image) ;
 *   • `top`    = direction opposée (−colDir).
 *
 * Accepte des `number` ou des chaînes DICOM (DS). Renvoie des bords vides
 * (« ») pour toute entrée invalide / dégénérée — l'appelant n'affiche alors
 * simplement aucune lettre, plutôt qu'une fausse orientation.
 *
 * Exemple (axial standard, patient sur le dos, tête en haut de l'écran) :
 *   iop = [1,0,0, 0,1,0] → top=A, bottom=P, left=R, right=L.
 */
export function edgeLabelsFromIop(
  iop: readonly (number | string)[] | null | undefined
): EdgeLabels {
  const empty: EdgeLabels = { top: "", bottom: "", left: "", right: "" };
  if (!iop || iop.length < 6) return empty;

  const nums: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = toFiniteNumber(iop[i]);
    if (n === null) return empty; // une composante non parsable → on s'abstient
    nums.push(n);
  }

  const rowDir: Vec3 = [nums[0], nums[1], nums[2]]; // axe X écran (→ droite)
  const colDir: Vec3 = [nums[3], nums[4], nums[5]]; // axe Y écran (→ bas)

  // Vecteurs nuls (IOP dégénéré) → pas d'orientation fiable.
  const rowMag = Math.hypot(rowDir[0], rowDir[1], rowDir[2]);
  const colMag = Math.hypot(colDir[0], colDir[1], colDir[2]);
  if (rowMag <= AXIS_THRESHOLD || colMag <= AXIS_THRESHOLD) return empty;

  return {
    right: orientationStringForVector(rowDir),
    left: orientationStringForVector(negate(rowDir)),
    bottom: orientationStringForVector(colDir),
    top: orientationStringForVector(negate(colDir)),
  };
}
