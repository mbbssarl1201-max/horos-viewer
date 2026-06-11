// Morphologie binaire pour les Brush ROIs (pinceau de segmentation).
//
// Reproduit les opérations du menu Horos « Erosion / Dilatation / Opening /
// Closing » appliquées à un masque binaire 2D. Un masque est un `Uint8Array`
// de longueur width × height en stockage ligne-par-ligne (row-major) : la
// valeur 0 = pixel hors ROI, toute valeur ≠ 0 = pixel dans la ROI.
//
// Toutes les fonctions sont PURES et déterministes : elles ne lisent ni
// n'écrivent le masque d'entrée, mais renvoient un NOUVEAU `Uint8Array`
// normalisé (0 ou 1). Aucune dépendance DOM / Cornerstone / I/O → testable
// hors navigateur.
//
// ── Définitions ──────────────────────────────────────────────────────────────
//   • Érosion  : un pixel reste à 1 ssi TOUS les pixels de l'élément structurant
//                (centré sur lui) sont à 1. Les bords du masque sont traités
//                comme « hors ROI » (= 0), donc l'érosion ronge les bords.
//   • Dilatation : un pixel passe à 1 ssi AU MOINS un pixel de l'élément
//                structurant (centré sur lui) est à 1.
//   • Opening  = érosion puis dilatation (retire les petites saillies / bruit).
//   • Closing  = dilatation puis érosion (bouche les petits trous).
//
// L'élément structurant est de rayon `radius` (≥ 1), de forme « carré »
// (voisinage de Chebyshev, (2r+1)² pixels) ou « croix » (voisinage de
// Manhattan, losange |dx|+|dy| ≤ r). `radius` est appliqué itérativement n'est
// PAS nécessaire : on évalue directement le voisinage complet de rayon r.

/** Forme de l'élément structurant. */
export type StructuringElement = "square" | "cross";

/** Options communes aux opérations morphologiques. */
export interface MorphologyOptions {
  /** Forme de l'élément structurant (défaut « square »). */
  shape?: StructuringElement;
}

/**
 * Valide les dimensions et la longueur du masque. Lève une `Error` explicite
 * si l'entrée est incohérente — les masques mal formés sont des bugs appelants,
 * pas des cas cliniques à ignorer silencieusement.
 */
function assertMaskShape(
  mask: Uint8Array,
  width: number,
  height: number
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("morphology: width/height doivent être des entiers");
  }
  if (width < 0 || height < 0) {
    throw new Error("morphology: width/height doivent être ≥ 0");
  }
  if (mask.length !== width * height) {
    throw new Error(
      `morphology: longueur du masque (${mask.length}) ≠ width×height (${width * height})`
    );
  }
}

/**
 * Précalcule la liste des décalages (dx, dy) de l'élément structurant de rayon
 * `radius` et de forme donnée. Le centre (0,0) est inclus.
 */
function structuringOffsets(
  radius: number,
  shape: StructuringElement
): { dx: number; dy: number }[] {
  const offsets: { dx: number; dy: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (shape === "cross" && Math.abs(dx) + Math.abs(dy) > radius) continue;
      offsets.push({ dx, dy });
    }
  }
  return offsets;
}

/**
 * Applique une opération morphologique élémentaire (érosion OU dilatation) en
 * un seul passage. `requireAll = true` ⇒ érosion (tous les voisins à 1) ;
 * `requireAll = false` ⇒ dilatation (au moins un voisin à 1). Les pixels hors
 * grille comptent comme 0.
 */
function morphPass(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  shape: StructuringElement,
  requireAll: boolean
): Uint8Array {
  const out = new Uint8Array(width * height);
  // Cas dégénéré : rayon 0 ⇒ identité (recopie normalisée en 0/1).
  if (radius <= 0) {
    for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 1 : 0;
    return out;
  }
  const offsets = structuringOffsets(radius, shape);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let result = requireAll ? 1 : 0;
      for (const { dx, dy } of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        // Hors grille → considéré comme 0 (fond).
        const inside = nx >= 0 && nx < width && ny >= 0 && ny < height;
        const v = inside && mask[ny * width + nx] ? 1 : 0;
        if (requireAll) {
          if (v === 0) {
            result = 0;
            break; // un seul voisin manquant suffit à éroder.
          }
        } else if (v === 1) {
          result = 1;
          break; // un seul voisin présent suffit à dilater.
        }
      }
      out[y * width + x] = result;
    }
  }
  return out;
}

/** Normalise `radius` : entier fini ≥ 0 (défaut 1, valeurs aberrantes → 0). */
function normalizeRadius(radius: number): number {
  if (!Number.isFinite(radius)) return 0;
  const r = Math.floor(radius);
  return r > 0 ? r : 0;
}

/**
 * Érosion binaire. Renvoie un nouveau masque (0/1) où chaque pixel reste à 1
 * ssi tout le voisinage (élément structurant de rayon `radius`) est à 1. Les
 * bords se comportent comme du fond (l'érosion ronge le contour).
 */
export function erode(
  mask: Uint8Array,
  width: number,
  height: number,
  radius = 1,
  opts: MorphologyOptions = {}
): Uint8Array {
  assertMaskShape(mask, width, height);
  return morphPass(
    mask,
    width,
    height,
    normalizeRadius(radius),
    opts.shape ?? "square",
    true
  );
}

/**
 * Dilatation binaire. Renvoie un nouveau masque (0/1) où chaque pixel passe à 1
 * ssi au moins un pixel du voisinage (élément structurant de rayon `radius`)
 * est à 1.
 */
export function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  radius = 1,
  opts: MorphologyOptions = {}
): Uint8Array {
  assertMaskShape(mask, width, height);
  return morphPass(
    mask,
    width,
    height,
    normalizeRadius(radius),
    opts.shape ?? "square",
    false
  );
}

/**
 * Ouverture (opening) = érosion puis dilatation. Retire les petites saillies et
 * le bruit isolé sans trop éroder les grandes structures.
 */
export function open(
  mask: Uint8Array,
  width: number,
  height: number,
  radius = 1,
  opts: MorphologyOptions = {}
): Uint8Array {
  const eroded = erode(mask, width, height, radius, opts);
  return dilate(eroded, width, height, radius, opts);
}

/**
 * Fermeture (closing) = dilatation puis érosion. Bouche les petits trous et
 * relie les composantes proches sans gonfler le contour global.
 */
export function close(
  mask: Uint8Array,
  width: number,
  height: number,
  radius = 1,
  opts: MorphologyOptions = {}
): Uint8Array {
  const dilated = dilate(mask, width, height, radius, opts);
  return erode(dilated, width, height, radius, opts);
}
