// Découpe de volume par polygone 2D projeté (menu 3D « Scissor Editing »).
//
// L'utilisateur trace un lasso/polygone à l'écran ; on l'utilise pour décider,
// pour chaque pixel d'une grille (la projection courante du volume), s'il est
// CONSERVÉ ou RETIRÉ. Le calcul est purement géométrique : aucune dépendance
// au DOM, à Cornerstone, à vtk ou à une quelconque I/O. Que des fonctions pures
// et déterministes, testables hors navigateur.
//
// Conventions :
//   • Un point est un couple `[x, y]` (coordonnées pixel/écran, x→droite,
//     y→bas — peu importe pour le test d'appartenance).
//   • Un polygone est une liste de sommets `[x, y][]`. Il est implicitement
//     FERMÉ : la dernière arête relie le dernier sommet au premier. Inutile de
//     répéter le premier sommet à la fin (toléré si présent).

/** Un point 2D `[x, y]`. */
export type Point2D = [number, number];

/** Un polygone : liste de sommets, fermeture implicite. */
export type Polygon2D = Point2D[];

/**
 * Test d'appartenance d'un point à un polygone par lancer de rayon (ray
 * casting / even-odd rule). On compte les arêtes que coupe un rayon horizontal
 * partant du point vers +∞ : nombre impair ⇒ intérieur, pair ⇒ extérieur.
 *
 * Détails de robustesse :
 *   • Polygone fermé implicitement (arête dernier→premier sommet).
 *   • Convention « half-open » sur l'axe y (`(yi > y) !== (yj > y)`) : un sommet
 *     pile à la hauteur du rayon n'est compté qu'une fois, ce qui évite les
 *     doubles comptages quand le rayon passe par un sommet.
 *   • Un polygone de moins de 3 sommets ne délimite aucune aire ⇒ `false`.
 *   • Comportement sur la frontière non garanti (cas dégénéré du even-odd) : un
 *     point exactement sur une arête peut être classé d'un côté ou de l'autre.
 *     Pour le clipping de volume c'est sans conséquence (un pixel de bord).
 */
export function pointInPolygon(point: Point2D, polygon: Polygon2D): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  const [px, py] = point;
  let inside = false;
  // j suit i d'un cran en arrière (arête i→j), en bouclant n-1 → 0.
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    // L'arête traverse-t-elle la hauteur py ? (half-open sur y)
    const straddles = yi > py !== yj > py;
    if (straddles) {
      // Abscisse de l'intersection de l'arête avec la droite y = py.
      const xCross = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Construit un masque de découpe pour une grille `width × height`.
 *
 * Le masque est un `Uint8Array` de longueur `width * height`, en ordre
 * row-major (index = `y * width + x`, x ∈ [0,width[, y ∈ [0,height[). Chaque
 * cellule est testée par son CENTRE `(x + 0.5, y + 0.5)` pour éviter les biais
 * de bord. La valeur vaut :
 *   • 1 ⇒ le voxel/pixel est CONSERVÉ,
 *   • 0 ⇒ il est RETIRÉ.
 *
 * `keepInside` choisit la sémantique du lasso :
 *   • `true`  : on garde ce qui est À L'INTÉRIEUR du polygone (« keep »),
 *   • `false` : on garde ce qui est À L'EXTÉRIEUR (« cut/erase » l'intérieur).
 *
 * Cas dégénérés (tableau tout-zéro de la bonne taille, jamais d'exception) :
 *   • `width` ou `height` ≤ 0, ou non entiers/non finis ⇒ masque vide (len 0).
 *   • polygone de moins de 3 sommets ⇒ aucune aire :
 *       - `keepInside=true`  ⇒ tout 0 (rien à garder),
 *       - `keepInside=false` ⇒ tout 1 (rien à retirer).
 */
export function clipMaskByPolygon(
  width: number,
  height: number,
  polygon: Polygon2D,
  keepInside: boolean
): Uint8Array {
  // Dimensions invalides ⇒ masque vide.
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return new Uint8Array(0);
  }

  const mask = new Uint8Array(width * height);

  // Polygone dégénéré : pas d'intérieur défini.
  if (polygon.length < 3) {
    // « extérieur » = toute la grille ⇒ tout conservé si on garde l'extérieur.
    if (!keepInside) mask.fill(1);
    return mask;
  }

  const kept = keepInside ? 1 : 0;
  const dropped = keepInside ? 0 : 1;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    const cy = y + 0.5;
    for (let x = 0; x < width; x++) {
      const inside = pointInPolygon([x + 0.5, cy], polygon);
      mask[rowBase + x] = inside ? kept : dropped;
    }
  }
  return mask;
}
