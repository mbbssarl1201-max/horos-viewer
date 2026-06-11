// Filtres de convolution image 2D — équivalent du menu Horos « Convolution
// Filters ». On applique un noyau (kernel) carré ou rectangulaire à une image
// monocanal (niveaux de gris, typiquement déjà fenêtrée en 8 bits ou en
// intensités brutes) pour la rehausser ou la lisser.
//
// Fonctions PURES et déterministes : aucune dépendance React / DOM / Cornerstone
// / vtk, aucune I/O. On ne manipule que des tableaux de nombres → testable hors
// navigateur.
//
// ── Rappel de la convolution 2D ──────────────────────────────────────────────
//   sortie(x,y) = ( Σ_i Σ_j  entrée(x+j-cx, y+i-cy) · noyau(i,j) ) / diviseur
//                 + biais
//
// où (cx,cy) est le centre du noyau. Le diviseur (divisor) normalise la somme
// des coefficients (somme du flou gaussien = 16 → divisor 16 pour préserver la
// luminosité) ; le biais (bias) recentre les filtres à somme nulle (Emboss) pour
// éviter une image quasi noire.
//
// ── Gestion des bords (clamp / « edge replication ») ─────────────────────────
// Pour un pixel proche du bord, certains voisins tombent hors image. On RÉPÈTE
// le pixel de bord le plus proche (clamp des coordonnées). C'est le choix de
// Horos / ImageJ : pas de halo noir au bord, contrairement au remplissage à 0.

/** Un noyau de convolution : matrice de lignes (chaque ligne = un tableau). */
export type Kernel = number[][];

/** Définition d'un filtre nommé prêt à l'emploi. */
export interface NamedKernel {
  /** Identifiant stable (clé), ex. « Sharpen ». */
  name: string;
  /** Libellé affichable dans le menu. */
  label: string;
  /** Matrice du noyau (lignes × colonnes). */
  kernel: Kernel;
  /**
   * Diviseur de normalisation. Défaut = somme des coefficients si > 0, sinon 1.
   * On le fixe explicitement pour rester lisible.
   */
  divisor?: number;
  /** Biais additif appliqué après division. Défaut 0. */
  bias?: number;
}

/**
 * Catalogue des filtres du menu « Convolution Filters ». Les noyaux sont les
 * classiques du traitement d'image (et de Horos / ImageJ) :
 *   • Sharpen      — rehaussement de netteté (Laplacian + identité).
 *   • Blur         — flou gaussien 3×3 (poids 1-2-1), divisor 16.
 *   • EdgeDetect   — détection de contours (Laplacien 8-voisins), somme nulle.
 *   • Emboss       — relief directionnel, somme nulle, bias 128 (gris médian).
 *   • Unsharp      — masquage flou (unsharp masking) : identité×2 − flou.
 *   • MedianApprox — approximation linéaire d'un lissage médian (moyenne 3×3).
 */
export const CONVOLUTION_KERNELS: readonly NamedKernel[] = [
  {
    name: "Sharpen",
    label: "Netteté",
    kernel: [
      [0, -1, 0],
      [-1, 5, -1],
      [0, -1, 0],
    ],
    divisor: 1,
    bias: 0,
  },
  {
    name: "Blur",
    label: "Flou (gaussien 3×3)",
    kernel: [
      [1, 2, 1],
      [2, 4, 2],
      [1, 2, 1],
    ],
    divisor: 16,
    bias: 0,
  },
  {
    name: "EdgeDetect",
    label: "Contours (Laplacien)",
    kernel: [
      [-1, -1, -1],
      [-1, 8, -1],
      [-1, -1, -1],
    ],
    divisor: 1,
    bias: 0,
  },
  {
    name: "Emboss",
    label: "Relief (emboss)",
    kernel: [
      [-2, -1, 0],
      [-1, 1, 1],
      [0, 1, 2],
    ],
    divisor: 1,
    bias: 128,
  },
  {
    name: "Unsharp",
    label: "Renforcement (unsharp)",
    kernel: [
      [-1, -1, -1],
      [-1, 9, -1],
      [-1, -1, -1],
    ],
    divisor: 1,
    bias: 0,
  },
  {
    name: "MedianApprox",
    label: "Lissage (médian approx.)",
    kernel: [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ],
    divisor: 9,
    bias: 0,
  },
];

/** Borne un entier dans [0, max] (clamp d'indice de bord). */
function clampIndex(v: number, max: number): number {
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

/**
 * Somme des coefficients d'un noyau (utile comme diviseur par défaut quand on
 * veut préserver la luminosité moyenne).
 */
export function kernelSum(kernel: Kernel): number {
  let s = 0;
  for (const row of kernel) {
    for (const c of row) s += c;
  }
  return s;
}

/**
 * Valide la forme d'un noyau : non vide, rectangulaire (toutes les lignes de
 * même longueur), dimensions IMPAIRES (centre bien défini) et coefficients
 * finis. Renvoie `null` si valide, sinon un message d'erreur.
 */
export function validateKernel(kernel: Kernel): string | null {
  if (!Array.isArray(kernel) || kernel.length === 0) {
    return "Noyau vide";
  }
  const h = kernel.length;
  const w = kernel[0]?.length ?? 0;
  if (w === 0) return "Noyau de largeur nulle";
  if (h % 2 === 0 || w % 2 === 0) {
    return "Dimensions du noyau doivent être impaires";
  }
  for (const row of kernel) {
    if (!Array.isArray(row) || row.length !== w) {
      return "Noyau non rectangulaire";
    }
    for (const c of row) {
      if (!Number.isFinite(c)) return "Coefficient de noyau non fini";
    }
  }
  return null;
}

/**
 * Applique un noyau de convolution à une image monocanal et renvoie un NOUVEAU
 * `Float32Array` (l'entrée n'est jamais mutée). Les bords sont gérés par clamp
 * (réplication du pixel de bord).
 *
 * @param pixels  intensités source, longueur attendue = width × height (row-major).
 * @param width   largeur en pixels (> 0).
 * @param height  hauteur en pixels (> 0).
 * @param kernel  matrice du noyau (lignes × colonnes, dimensions impaires).
 * @param divisor diviseur de normalisation ; défaut = kernelSum si ≠ 0, sinon 1.
 * @param bias    biais additif après division ; défaut 0.
 *
 * Lève une `Error` si l'image ou le noyau sont invalides (dimensions
 * incohérentes, longueur de tableau erronée, divisor = 0). On préfère échouer
 * franchement que produire des pixels faux silencieusement.
 */
export function applyKernel(
  pixels: Float32Array | number[],
  width: number,
  height: number,
  kernel: Kernel,
  divisor?: number,
  bias?: number
): Float32Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Dimensions image invalides");
  }
  if (pixels.length !== width * height) {
    throw new Error(
      `Longueur pixels (${pixels.length}) ≠ width×height (${width * height})`
    );
  }
  const kErr = validateKernel(kernel);
  if (kErr) throw new Error(kErr);

  const kh = kernel.length;
  const kw = kernel[0].length;
  const cy = (kh - 1) / 2; // centre vertical
  const cx = (kw - 1) / 2; // centre horizontal

  // Diviseur : explicite, sinon somme du noyau (si ≠ 0), sinon 1.
  let div = divisor;
  if (div === undefined) {
    const s = kernelSum(kernel);
    div = s !== 0 ? s : 1;
  }
  if (div === 0) throw new Error("Diviseur nul");
  const b = bias ?? 0;

  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = 0; i < kh; i++) {
        // Coordonnée source en y, clampée au bord.
        const sy = clampIndex(y + i - cy, height - 1);
        const rowBase = sy * width;
        const krow = kernel[i];
        for (let j = 0; j < kw; j++) {
          const sx = clampIndex(x + j - cx, width - 1);
          acc += pixels[rowBase + sx] * krow[j];
        }
      }
      out[y * width + x] = acc / div + b;
    }
  }
  return out;
}

/**
 * Applique un filtre nommé du catalogue par sa clé `name`. Pratique pour le
 * menu : on passe le nom du filtre sélectionné. Lève une `Error` si la clé est
 * inconnue.
 */
export function applyNamedFilter(
  pixels: Float32Array | number[],
  width: number,
  height: number,
  name: string
): Float32Array {
  const f = CONVOLUTION_KERNELS.find(k => k.name === name);
  if (!f) throw new Error(`Filtre de convolution inconnu : « ${name} »`);
  return applyKernel(pixels, width, height, f.kernel, f.divisor, f.bias);
}
