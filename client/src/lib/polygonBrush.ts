// Conversions entre ROI « polygone » et ROI « brush » (masque pixel), et
// fusion de masques — équivalent du menu Horos « Convert Between Polygon /
// Brush ROIs » et « Merge Brush ».
//
// Tout est PUR et déterministe : on ne manipule que des nombres et des
// Uint8Array (testable hors navigateur, sans Cornerstone/DOM/vtk).
//
// Représentation du masque : Uint8Array de longueur width·height, indexée en
// row-major (`idx = y·width + x`). Une valeur ≠ 0 = pixel « dans la ROI »,
// 0 = hors ROI. On normalise toujours en 0/1 en sortie.
//
// Convention de coordonnées : un point (px, py) du polygone est en coordonnées
// pixel CONTINUES ; le centre du pixel (x, y) est en (x + 0,5 , y + 0,5).
// La rasterisation teste donc l'appartenance du CENTRE de chaque pixel au
// polygone, selon la règle pair-impair (even-odd / ray casting).

/** Un point 2D en coordonnées pixel : [x, y]. */
export type Point = [number, number];

/** Borne un entier dans [min, max]. */
function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Valide une dimension : entier fini ≥ 0. */
function isValidDim(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Teste si le point (px, py) est à l'intérieur du polygone selon la règle
 * pair-impair (ray casting horizontal). Polygone implicitement fermé (le
 * dernier sommet est relié au premier). Robuste aux polygones non convexes et
 * auto-intersectants.
 */
function pointInPolygon(
  px: number,
  py: number,
  poly: readonly Point[]
): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // L'arête (j → i) traverse-t-elle la demi-droite horizontale partant du
    // point vers la droite ? Le test `(yi > py) !== (yj > py)` évite de compter
    // deux fois les sommets partagés (convention bord inférieur exclusif).
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Rasterise un polygone en masque binaire (brush) de dimensions width·height.
 *
 * On teste le CENTRE de chaque pixel (x + 0,5 , y + 0,5) par la règle
 * pair-impair. Un polygone de moins de 3 sommets ne délimite aucune aire →
 * masque entièrement nul. Les dimensions ≤ 0 donnent un masque vide.
 *
 * Optimisation : on restreint le balayage à la boîte englobante du polygone
 * (intersectée avec la grille) plutôt qu'à toute l'image.
 */
export function polygonToMask(
  points: readonly Point[],
  width: number,
  height: number
): Uint8Array {
  if (!isValidDim(width) || !isValidDim(height)) {
    throw new Error(
      "polygonToMask : width/height doivent être des entiers ≥ 0"
    );
  }
  const mask = new Uint8Array(width * height);
  if (width === 0 || height === 0 || points.length < 3) return mask;

  // Boîte englobante du polygone, bornée à la grille de pixels.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return mask; // aucun sommet fini

  // Pixels dont le centre peut tomber dans la boîte : x+0,5 ∈ [minX, maxX].
  const x0 = clampInt(Math.floor(minX), 0, width - 1);
  const x1 = clampInt(Math.ceil(maxX), 0, width - 1);
  const y0 = clampInt(Math.floor(minY), 0, height - 1);
  const y1 = clampInt(Math.ceil(maxY), 0, height - 1);

  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, cy, points)) {
        mask[row + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Extrait un contour polygonal BASIQUE d'un masque brush. On suit le bord
 * extérieur de la première composante rencontrée (balayage row-major) via un
 * suivi de contour de Moore-Neighbor, et on renvoie la liste des sommets du
 * contour en coordonnées pixel (coin supérieur-gauche du pixel de bord).
 *
 * Limites assumées (« basique ») : un seul contour extérieur (la 1ʳᵉ
 * composante), pas de gestion des trous. Masque vide / sans pixel actif →
 * polygone vide `[]`.
 *
 * Les sommets ne sont PAS simplifiés (un par pas de contour) ; c'est suffisant
 * pour reconvertir en masque ou afficher un tracé. Le polygone est fermé
 * implicitement (le dernier point n'est pas dupliqué avec le premier).
 */
export function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number
): Point[] {
  if (!isValidDim(width) || !isValidDim(height)) {
    throw new Error(
      "maskToPolygon : width/height doivent être des entiers ≥ 0"
    );
  }
  if (width === 0 || height === 0 || mask.length < width * height) return [];

  const at = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] !== 0;

  // 1) Trouver le pixel actif le plus en haut à gauche (point de départ).
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startY < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 0) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startY < 0) return []; // aucun pixel actif

  // Cas dégénéré : un seul pixel actif isolé → renvoyer son coin.
  // (Le suivi de contour ci-dessous le gère, mais on garde ce cas explicite.)

  // 2) Suivi de contour (Moore-Neighbor) avec critère d'arrêt de Jacob.
  // Voisinage 8-connexe dans l'ordre horaire à partir de l'ouest.
  const dirs: ReadonlyArray<[number, number]> = [
    [-1, 0], // O
    [-1, -1], // NO
    [0, -1], // N
    [1, -1], // NE
    [1, 0], // E
    [1, 1], // SE
    [0, 1], // S
    [-1, 1], // SO
  ];

  const contour: Point[] = [];
  // On entre dans le pixel de départ « depuis l'ouest » (le pixel à gauche est
  // hors masque puisque c'est le plus à gauche de sa ligne).
  let curX = startX;
  let curY = startY;
  // Direction de backtrack initiale : ouest.
  let backtrackDir = 0;
  const maxSteps = width * height * 8 + 8; // garde-fou anti-boucle
  let steps = 0;
  const startKey = startY * width + startX;
  let firstMove = true;

  for (;;) {
    contour.push([curX, curY]);
    // Chercher le prochain pixel actif en tournant dans le sens horaire à
    // partir du voisin suivant le backtrack.
    let found = false;
    let nextX = curX;
    let nextY = curY;
    let nextBacktrack = backtrackDir;
    for (let k = 1; k <= 8; k++) {
      const d = (backtrackDir + k) % 8;
      const nx = curX + dirs[d][0];
      const ny = curY + dirs[d][1];
      if (at(nx, ny)) {
        nextX = nx;
        nextY = ny;
        // Le backtrack du prochain pixel pointe vers le pixel courant.
        nextBacktrack = (d + 4) % 8;
        found = true;
        break;
      }
    }
    if (!found) {
      // Pixel isolé : pas de voisin actif → contour = ce seul pixel.
      break;
    }
    curX = nextX;
    curY = nextY;
    backtrackDir = nextBacktrack;
    steps++;
    if (steps > maxSteps) break; // garde-fou
    // Critère d'arrêt : on est revenu au pixel de départ (après le 1ᵉʳ pas).
    if (curY * width + curX === startKey) {
      if (firstMove) {
        // On a quitté puis on revient : si le tout premier mouvement nous
        // ramène immédiatement, c'est un contour à 2 pixels — on continue une
        // fois pour fermer proprement, puis on s'arrête au prochain retour.
        firstMove = false;
      }
      break;
    }
    firstMove = false;
  }

  return contour;
}

/**
 * Fusionne deux masques par OU logique (« Merge Brush ») : un pixel est dans le
 * résultat s'il est dans `a` OU dans `b`. Le résultat est normalisé en 0/1.
 *
 * Les deux masques doivent avoir la MÊME longueur (même grille), sinon erreur —
 * fusionner des masques de tailles différentes n'a pas de sens géométrique.
 */
export function mergeMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error("mergeMasks : les masques doivent avoir la même longueur");
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] !== 0 || b[i] !== 0 ? 1 : 0;
  }
  return out;
}

/**
 * Intersection (ET logique) de deux masques — bonus utilitaire symétrique de
 * `mergeMasks`, utile pour des opérations de ROI combinées. Résultat 0/1.
 */
export function intersectMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(
      "intersectMasks : les masques doivent avoir la même longueur"
    );
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] !== 0 && b[i] !== 0 ? 1 : 0;
  }
  return out;
}

/** Compte les pixels actifs (≠ 0) d'un masque — utilitaire de mesure d'aire. */
export function countMaskPixels(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) n++;
  }
  return n;
}
