// Croissance de région (region growing) 2D / 3D — menu « Grow Region
// (2D/3D Segmentation) » d'Horos.
//
// Principe : à partir d'un point « graine » (seed) et d'une fenêtre d'intensité
// [lo, hi], on agrège par PROPAGATION (flood fill) tous les voxels voisins dont
// la valeur tombe dans la fenêtre. Le résultat est un masque binaire (0/1) de
// même géométrie que l'entrée.
//
// Fonctions 100 % PURES et déterministes : aucune dépendance React / DOM /
// Cornerstone / vtk / I/O. On ne manipule que des tableaux de nombres. La
// propagation utilise une PILE explicite (pas de récursion) pour ne pas faire
// déborder la pile JS sur de gros volumes.
//
// ── Conventions ──────────────────────────────────────────────────────────────
//   • Indexation 2D : idx = y * width + x   (x rapide, y lent).
//   • Indexation 3D : idx = z * (nx * ny) + y * nx + x  (x rapide, z lent).
//   • Connexité 2D : 4 (von Neumann) par défaut, ou 8 (Moore) en option.
//   • Connexité 3D : 6 (faces) par défaut, ou 26 (faces+arêtes+coins).
//   • Le test d'inclusion est INCLUSIF aux deux bornes : lo ≤ v ≤ hi. Si lo > hi
//     les bornes sont silencieusement échangées (tolérance ergonomique).
//   • Graine hors champ ou hors fenêtre → masque entièrement vide (aucune
//     exception levée).

/** Connexité de voisinage en 2D. */
export type Connectivity2D = 4 | 8;

/** Connexité de voisinage en 3D. */
export type Connectivity3D = 6 | 26;

/** Borne une valeur entière dans [min, max]. */
function clampInt(v: number, min: number, max: number): number {
  const n = Math.trunc(v);
  return n < min ? min : n > max ? max : n;
}

/**
 * Croissance de région 2D (flood fill) sur une image en niveaux de gris.
 *
 * @param pixels        intensités, longueur attendue = width * height (idx = y*width + x).
 * @param width         largeur en pixels (> 0).
 * @param height        hauteur en pixels (> 0).
 * @param seed          point de départ [x, y] (arrondi/borné au champ).
 * @param lowerThreshold borne basse incluse de la fenêtre d'intensité.
 * @param upperThreshold borne haute incluse (échangée avec la basse si lo > hi).
 * @param connectivity  4 (défaut) ou 8.
 * @returns Uint8Array de longueur width*height : 1 = dans la région, 0 sinon.
 *
 * Robustesse : dimensions ≤ 0, longueur de `pixels` incohérente, graine hors
 * champ ou hors fenêtre, valeurs non finies → masque entièrement à 0 (jamais
 * d'exception). La graine elle-même n'est marquée que si elle satisfait la
 * fenêtre.
 */
export function growRegion2D(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  seed: [number, number],
  lowerThreshold: number,
  upperThreshold: number,
  connectivity: Connectivity2D = 4
): Uint8Array {
  const w = Math.trunc(width);
  const h = Math.trunc(height);

  // Dimensions invalides → masque vide de taille 0 (rien à segmenter).
  if (w <= 0 || h <= 0) return new Uint8Array(0);

  const n = w * h;
  const mask = new Uint8Array(n);

  // Tableau d'entrée incohérent → tout à 0.
  if (!pixels || pixels.length < n) return mask;

  // Fenêtre d'intensité (bornes échangées si dans le mauvais ordre).
  let lo = lowerThreshold;
  let hi = upperThreshold;
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return mask;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }

  // Graine bornée au champ.
  const sx = clampInt(seed[0], 0, w - 1);
  const sy = clampInt(seed[1], 0, h - 1);
  const seedIdx = sy * w + sx;

  const inWindow = (v: number): boolean =>
    Number.isFinite(v) && v >= lo && v <= hi;

  // Si la graine n'est pas dans la fenêtre, la région est vide.
  if (!inWindow(pixels[seedIdx])) return mask;

  // Propagation par pile explicite (DFS). On stocke des index linéaires.
  const stack: number[] = [seedIdx];
  mask[seedIdx] = 1;

  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % w;
    const y = (idx - x) / w;

    // Voisins 4-connexes (haut/bas/gauche/droite).
    pushNeighbor2D(x - 1, y, w, h, pixels, mask, stack, inWindow);
    pushNeighbor2D(x + 1, y, w, h, pixels, mask, stack, inWindow);
    pushNeighbor2D(x, y - 1, w, h, pixels, mask, stack, inWindow);
    pushNeighbor2D(x, y + 1, w, h, pixels, mask, stack, inWindow);

    if (connectivity === 8) {
      // Diagonales (8-connexité).
      pushNeighbor2D(x - 1, y - 1, w, h, pixels, mask, stack, inWindow);
      pushNeighbor2D(x + 1, y - 1, w, h, pixels, mask, stack, inWindow);
      pushNeighbor2D(x - 1, y + 1, w, h, pixels, mask, stack, inWindow);
      pushNeighbor2D(x + 1, y + 1, w, h, pixels, mask, stack, inWindow);
    }
  }

  return mask;
}

/** Empile un voisin 2D s'il est dans le champ, non visité et dans la fenêtre. */
function pushNeighbor2D(
  x: number,
  y: number,
  w: number,
  h: number,
  pixels: ArrayLike<number>,
  mask: Uint8Array,
  stack: number[],
  inWindow: (v: number) => boolean
): void {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const idx = y * w + x;
  if (mask[idx]) return; // déjà visité
  if (!inWindow(pixels[idx])) return;
  mask[idx] = 1;
  stack.push(idx);
}

/**
 * Croissance de région 3D (flood fill volumique).
 *
 * @param volume        intensités, longueur attendue = nx*ny*nz
 *                      (idx = z*nx*ny + y*nx + x).
 * @param dims          dimensions [nx, ny, nz] (chacune > 0).
 * @param seed          graine [x, y, z] (bornée au volume).
 * @param lo            borne basse incluse.
 * @param hi            borne haute incluse (échangée si lo > hi).
 * @param connectivity  6 (faces, défaut) ou 26 (faces + arêtes + coins).
 * @returns Uint8Array de longueur nx*ny*nz : 1 = région, 0 sinon.
 *
 * Même politique de robustesse que `growRegion2D` : toute entrée invalide donne
 * un masque à 0 (taille 0 si dims invalides), aucune exception.
 */
export function growRegion3D(
  volume: ArrayLike<number>,
  dims: [number, number, number],
  seed: [number, number, number],
  lo: number,
  hi: number,
  connectivity: Connectivity3D = 6
): Uint8Array {
  const nx = Math.trunc(dims[0]);
  const ny = Math.trunc(dims[1]);
  const nz = Math.trunc(dims[2]);

  if (nx <= 0 || ny <= 0 || nz <= 0) return new Uint8Array(0);

  const slice = nx * ny;
  const n = slice * nz;
  const mask = new Uint8Array(n);

  if (!volume || volume.length < n) return mask;

  let low = lo;
  let high = hi;
  if (!(Number.isFinite(low) && Number.isFinite(high))) return mask;
  if (low > high) {
    const t = low;
    low = high;
    high = t;
  }

  const sx = clampInt(seed[0], 0, nx - 1);
  const sy = clampInt(seed[1], 0, ny - 1);
  const sz = clampInt(seed[2], 0, nz - 1);
  const seedIdx = sz * slice + sy * nx + sx;

  const inWindow = (v: number): boolean =>
    Number.isFinite(v) && v >= low && v <= high;

  if (!inWindow(volume[seedIdx])) return mask;

  // Offsets de voisinage précalculés selon la connexité.
  const offsets = neighborOffsets3D(connectivity);

  const stack: number[] = [seedIdx];
  mask[seedIdx] = 1;

  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const z = Math.trunc(idx / slice);
    const rem = idx - z * slice;
    const y = Math.trunc(rem / nx);
    const x = rem - y * nx;

    for (let k = 0; k < offsets.length; k++) {
      const dx = offsets[k][0];
      const dy = offsets[k][1];
      const dz = offsets[k][2];
      const xx = x + dx;
      const yy = y + dy;
      const zz = z + dz;
      if (xx < 0 || xx >= nx || yy < 0 || yy >= ny || zz < 0 || zz >= nz) {
        continue;
      }
      const nIdx = zz * slice + yy * nx + xx;
      if (mask[nIdx]) continue;
      if (!inWindow(volume[nIdx])) continue;
      mask[nIdx] = 1;
      stack.push(nIdx);
    }
  }

  return mask;
}

/**
 * Décalages de voisinage 3D. 6-connexité = les 6 faces ; 26-connexité = toutes
 * les combinaisons (dx,dy,dz) ∈ {-1,0,1}³ sauf (0,0,0).
 */
function neighborOffsets3D(
  connectivity: Connectivity3D
): ReadonlyArray<readonly [number, number, number]> {
  if (connectivity === 6) {
    return [
      [-1, 0, 0],
      [1, 0, 0],
      [0, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
    ];
  }
  const out: Array<[number, number, number]> = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        out.push([dx, dy, dz]);
      }
    }
  }
  return out;
}

/** Compte les voxels marqués (1) dans un masque — utilitaire pratique/tests. */
export function countMask(mask: ArrayLike<number>): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) c++;
  }
  return c;
}
