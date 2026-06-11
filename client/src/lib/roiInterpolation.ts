// Génération de ROIs manquantes par interpolation entre deux coupes clés
// (menu « Generate Missing ROIs »). Quand un médecin a contouré une structure
// sur deux coupes seulement, on reconstruit les contours intermédiaires en
// interpolant linéairement entre les deux contours clés.
//
// Difficulté : les deux contours n'ont en général PAS le même nombre de points
// (ni la même origine de parcours). On les ré-échantillonne donc d'abord sur un
// nombre COMMUN de points, régulièrement espacés le long du périmètre, puis on
// interpole point à point.
//
// Fonctions 100 % PURES et déterministes : que des nombres, aucune dépendance
// DOM / Cornerstone / vtk. Un point est un tuple [x, y].

/** Un point 2D : [x, y]. */
export type Point = [number, number];

/** Un contour = liste ordonnée de points (polygone fermé implicitement). */
export type Contour = Point[];

/** Distance euclidienne entre deux points. */
function distance(a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

/** Interpolation linéaire entre deux points (t ∈ [0,1]). */
function lerpPoint(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Ré-échantillonne un contour FERMÉ sur exactement `n` points régulièrement
 * espacés le long de son périmètre (la fermeture relie le dernier point au
 * premier). Le parcours conserve l'orientation d'origine et démarre au premier
 * point du contour.
 *
 * Cas dégénérés (renvoie un résultat sûr, jamais d'exception ni de NaN) :
 *   • `n <= 0`               → [] (rien à produire)
 *   • contour vide           → [] quel que soit n
 *   • 1 seul point           → ce point dupliqué n fois (contour ponctuel)
 *   • périmètre nul (points  → premier point dupliqué n fois
 *     tous confondus)
 */
export function resampleContour(points: Contour, n: number): Contour {
  if (n <= 0) return [];
  const count = points.length;
  if (count === 0) return [];
  // Copie défensive (on ne mute jamais l'entrée).
  const pts: Contour = points.map(p => [p[0], p[1]]);
  if (count === 1) {
    return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as Point);
  }

  // Longueurs cumulées le long du contour fermé : segments p0→p1 … p(k-1)→p0.
  const segLen: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % count];
    const d = distance(a, b);
    segLen.push(d);
    perimeter += d;
  }

  // Périmètre nul : tous les points confondus → on renvoie le premier, n fois.
  if (perimeter === 0) {
    return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as Point);
  }

  // Position cumulée du DÉBUT de chaque segment.
  const startDist: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    startDist.push(acc);
    acc += segLen[i];
  }

  // n positions cibles régulièrement espacées sur [0, périmètre).
  const step = perimeter / n;
  const out: Contour = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    // Avance jusqu'au segment contenant `target` (segments de longueur 0 sautés).
    while (seg < count - 1 && startDist[seg] + segLen[seg] <= target) {
      seg++;
    }
    const a = pts[seg];
    const b = pts[(seg + 1) % count];
    const len = segLen[seg];
    const t = len > 0 ? (target - startDist[seg]) / len : 0;
    out.push(lerpPoint(a, b, t));
  }
  return out;
}

/**
 * Interpole des contours intermédiaires entre `contourA` et `contourB`.
 *
 * `steps` = nombre de contours INTERMÉDIAIRES à générer (les coupes clés A et B
 * NE sont PAS incluses dans le résultat). Pour `steps = k`, on renvoie k
 * contours aux fractions t = 1/(k+1), 2/(k+1), …, k/(k+1).
 *
 * Les deux contours sont d'abord ré-échantillonnés sur un nombre COMMUN de
 * points (le max des deux tailles, borné à ≥ 1), afin d'interpoler point à
 * point de façon cohérente.
 *
 * Cas dégénérés :
 *   • `steps <= 0`                 → [] (rien à générer)
 *   • A et B tous deux vides       → `steps` contours vides
 *   • un seul des deux vide        → on duplique le contour non vide aux
 *     positions interpolées (faute de mieux : pas d'apparition/disparition
 *     progressive depuis le néant)
 */
export function interpolateContours(
  contourA: Contour,
  contourB: Contour,
  steps: number
): Contour[] {
  if (steps <= 0) return [];

  const aEmpty = contourA.length === 0;
  const bEmpty = contourB.length === 0;

  // Les deux vides : on ne peut rien interpoler → contours vides.
  if (aEmpty && bEmpty) {
    return Array.from({ length: steps }, () => []);
  }

  // Nombre commun de points : le plus grand des deux (au moins 1).
  const n = Math.max(contourA.length, contourB.length, 1);

  // Si l'un est vide, on duplique l'autre (ré-échantillonné) à chaque step.
  const ra = aEmpty
    ? resampleContour(contourB, n)
    : resampleContour(contourA, n);
  const rb = bEmpty
    ? resampleContour(contourA, n)
    : resampleContour(contourB, n);

  const out: Contour[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1);
    const c: Contour = [];
    for (let k = 0; k < n; k++) {
      c.push(lerpPoint(ra[k], rb[k], t));
    }
    out.push(c);
  }
  return out;
}
