// Édition de pixels dans une ROI (menu « Set Pixel Values to... »).
//
// Reproduction de la fonction Horos qui permet de redéfinir la valeur des
// pixels d'une image à l'intérieur (ou à l'extérieur) d'une région d'intérêt
// dessinée par l'utilisateur. Usage typique : effacer un implant, neutraliser
// un artefact, ou normaliser une zone.
//
// Fonctions 100 % PURES et déterministes : on ne manipule que des tableaux de
// nombres et un masque binaire. Aucune dépendance Cornerstone / DOM / I/O →
// testable hors navigateur.
//
// Le masque est un `Uint8Array` parallèle au tableau de pixels : un octet par
// pixel, valeur ≠ 0 = pixel DANS la ROI, valeur 0 = pixel hors ROI. Le masque
// DOIT avoir la même longueur que le tableau de pixels ; sinon on lève une
// erreur (incohérence de l'appelant, pas une donnée patient à tolérer).
//
// Immutabilité : aucune des fonctions ne modifie `pixels` ni `mask` ; elles
// renvoient TOUJOURS un nouveau tableau.

/** Opération applicable aux pixels d'une ROI. */
export type RoiPixelOp = "set" | "add" | "min" | "max";

/** Vérifie que masque et pixels sont cohérents en longueur. */
function assertSameLength(pixels: readonly number[], mask: Uint8Array): void {
  if (mask.length !== pixels.length) {
    throw new Error(
      `Masque et pixels de longueurs différentes : ${mask.length} ≠ ${pixels.length}`
    );
  }
}

/**
 * Remplace par `value` la valeur de chaque pixel situé DANS le masque
 * (octet ≠ 0). Les pixels hors masque sont recopiés à l'identique. Renvoie un
 * NOUVEAU tableau (la source n'est jamais mutée).
 */
export function setPixelsInMask(
  pixels: readonly number[],
  mask: Uint8Array,
  value: number
): number[] {
  assertSameLength(pixels, mask);
  const out = new Array<number>(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    out[i] = mask[i] !== 0 ? value : pixels[i];
  }
  return out;
}

/**
 * Remplace par `value` la valeur de chaque pixel situé HORS du masque
 * (octet = 0). Les pixels dans le masque sont recopiés à l'identique. Renvoie
 * un NOUVEAU tableau (la source n'est jamais mutée).
 */
export function setPixelsOutsideMask(
  pixels: readonly number[],
  mask: Uint8Array,
  value: number
): number[] {
  assertSameLength(pixels, mask);
  const out = new Array<number>(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    out[i] = mask[i] === 0 ? value : pixels[i];
  }
  return out;
}

/**
 * Applique une opération `op` avec l'opérande `value` à chaque pixel situé DANS
 * le masque (octet ≠ 0). Les pixels hors masque sont recopiés à l'identique.
 *
 *   • « set » : pixel ← value
 *   • « add » : pixel ← pixel + value (soustraction = value négatif)
 *   • « min » : pixel ← min(pixel, value) (plafonne vers le bas)
 *   • « max » : pixel ← max(pixel, value) (plancher vers le haut)
 *
 * Renvoie un NOUVEAU tableau (la source n'est jamais mutée).
 */
export function applyToRoi(
  pixels: readonly number[],
  mask: Uint8Array,
  op: RoiPixelOp,
  value: number
): number[] {
  assertSameLength(pixels, mask);
  const out = new Array<number>(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (mask[i] === 0) {
      out[i] = p;
      continue;
    }
    switch (op) {
      case "set":
        out[i] = value;
        break;
      case "add":
        out[i] = p + value;
        break;
      case "min":
        out[i] = Math.min(p, value);
        break;
      case "max":
        out[i] = Math.max(p, value);
        break;
      default: {
        // Garde d'exhaustivité : toute nouvelle op doit être traitée ci-dessus.
        const _never: never = op;
        throw new Error(`Opération ROI inconnue : ${String(_never)}`);
      }
    }
  }
  return out;
}
