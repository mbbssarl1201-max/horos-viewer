// Soustraction d'images type DSA / angiographie numérique (menu Horos
// « Subtraction »). En angiographie soustraite, on acquiert d'abord une image
// « masque » (avant injection du produit de contraste) puis des images
// « live » (avec contraste). La soustraction live − masque efface l'anatomie
// fixe (os, tissus mous) et ne laisse apparaître que les vaisseaux opacifiés.
//
// Outils annexes du même menu :
//   • Pixel shift  : recale le masque sur le live d'un petit décalage (dx,dy)
//                    pour compenser un léger mouvement du patient entre les
//                    deux acquisitions (8 directions + « aucun »).
//   • Sum / pondération : somme/moyenne pondérée de plusieurs images.
//   • Contraste / luminosité : ajustement linéaire de la fenêtre de sortie.
//
// Module 100 % PUR et déterministe : aucune dépendance React / DOM /
// Cornerstone / vtk, aucune I/O. On ne manipule que des tableaux de nombres
// (intensités de pixels, indexées ligne par ligne, row-major). Testable hors
// navigateur.

/** Décalage entier d'un pixel shift : `dx` colonnes, `dy` lignes. */
export interface PixelShift {
  /** Décalage horizontal en colonnes (positif = vers la droite). */
  dx: number;
  /** Décalage vertical en lignes (positif = vers le bas). */
  dy: number;
}

/**
 * Table des décalages du « pixel shift » Horos : 8 directions cardinales /
 * diagonales + « aucun ». Convention écran : x croît vers la droite, y croît
 * vers le bas. « N » (nord) décale donc d'une ligne vers le HAUT (dy = -1).
 */
export const PIXEL_SHIFTS: Readonly<Record<string, PixelShift>> = Object.freeze(
  {
    NW: { dx: -1, dy: -1 },
    N: { dx: 0, dy: -1 },
    NE: { dx: 1, dy: -1 },
    W: { dx: -1, dy: 0 },
    none: { dx: 0, dy: 0 },
    E: { dx: 1, dy: 0 },
    SW: { dx: -1, dy: 1 },
    S: { dx: 0, dy: 1 },
    SE: { dx: 1, dy: 1 },
  }
);

/**
 * Soustraction de masque : renvoie `live[i] − mask[i]` pour chaque pixel. Le
 * résultat n'est PAS borné/clampé ici — l'image de différence peut être
 * négative ; c'est l'étage d'affichage (fenêtrage / contraste) qui décidera de
 * la représentation. On garde donc les valeurs brutes (signées).
 *
 * Les deux tableaux DOIVENT avoir la même longueur, sinon on lève une erreur
 * (deux images de tailles différentes n'ont pas de soustraction définie).
 */
export function subtractMask(live: number[], mask: number[]): number[] {
  if (live.length !== mask.length) {
    throw new Error(
      `subtractMask : tailles incompatibles (live=${live.length}, mask=${mask.length})`
    );
  }
  const out = new Array<number>(live.length);
  for (let i = 0; i < live.length; i++) {
    out[i] = live[i] - mask[i];
  }
  return out;
}

/**
 * Applique un décalage entier (dx, dy) à une image row-major de dimensions
 * `width`×`height`. Les pixels « entrants » (qui n'ont pas d'antécédent dans
 * l'image source, sur les bords découverts par le décalage) sont remplis à 0.
 *
 * Convention : `out[y][x] = src[y − dy][x − dx]` quand la source est dans les
 * bornes, sinon 0. Autrement dit l'image est « poussée » de (dx, dy) : un
 * décalage E (dx=+1) déplace le contenu vers la droite, laissant la colonne 0
 * à zéro.
 *
 * Erreur si `width`/`height` sont incohérents avec la longueur du tableau, ou
 * non entiers positifs. `dx`/`dy` sont tronqués à l'entier.
 */
export function applyPixelShift(
  pixels: number[],
  width: number,
  height: number,
  dx: number,
  dy: number
): number[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error(
      `applyPixelShift : dimensions invalides (${width}×${height})`
    );
  }
  if (width * height !== pixels.length) {
    throw new Error(
      `applyPixelShift : ${width}×${height} ≠ ${pixels.length} pixels`
    );
  }
  const sx = Math.trunc(dx);
  const sy = Math.trunc(dy);
  const out = new Array<number>(pixels.length).fill(0);
  if (pixels.length === 0) return out;
  for (let y = 0; y < height; y++) {
    const srcY = y - sy;
    if (srcY < 0 || srcY >= height) continue; // ligne entièrement découverte
    for (let x = 0; x < width; x++) {
      const srcX = x - sx;
      if (srcX < 0 || srcX >= width) continue; // pixel découvert → reste 0
      out[y * width + x] = pixels[srcY * width + srcX];
    }
  }
  return out;
}

/**
 * Somme pondérée de plusieurs images de MÊME taille : pour chaque pixel,
 * `factor × Σ images[k][i]`. Avec `factor = 1` on obtient la somme brute ;
 * avec `factor = 1/N` la moyenne (intégration de bruit, fréquent en DSA pour
 * améliorer le rapport signal/bruit).
 *
 * Renvoie un tableau vide si `images` est vide. Toutes les images doivent
 * partager la longueur de la première, sinon erreur.
 */
export function sumImages(images: number[][], factor: number): number[] {
  if (images.length === 0) return [];
  const len = images[0].length;
  for (let k = 1; k < images.length; k++) {
    if (images[k].length !== len) {
      throw new Error(
        `sumImages : image #${k} de taille ${images[k].length} ≠ ${len}`
      );
    }
  }
  const out = new Array<number>(len).fill(0);
  for (const img of images) {
    for (let i = 0; i < len; i++) {
      out[i] += img[i];
    }
  }
  if (factor !== 1) {
    for (let i = 0; i < len; i++) {
      out[i] *= factor;
    }
  }
  return out;
}

/**
 * Ajustement linéaire contraste / luminosité d'une image, à la façon des
 * curseurs Horos. On applique, autour du point milieu 0 :
 *
 *   out = (pixel × gain) + brightnessDelta
 *
 * où `gain = 1 + contrastDelta`. Ainsi `contrastDelta = 0` et
 * `brightnessDelta = 0` laissent l'image inchangée ; `contrastDelta > 0`
 * étire l'échelle (plus de contraste), `contrastDelta = -1` aplatit tout à la
 * seule luminosité. `brightnessDelta` décale l'ensemble.
 *
 * Les valeurs ne sont PAS clampées ici (l'étage d'affichage gère la plage) ;
 * on renvoie des intensités potentiellement négatives ou hors-plage.
 */
export function adjustContrastBrightness(
  pixels: number[],
  contrastDelta: number,
  brightnessDelta: number
): number[] {
  const gain = 1 + contrastDelta;
  const out = new Array<number>(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    out[i] = pixels[i] * gain + brightnessDelta;
  }
  return out;
}
