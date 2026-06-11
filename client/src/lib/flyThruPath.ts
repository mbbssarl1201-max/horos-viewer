/**
 * Trajectoire de fly-through 3D / endoscopie virtuelle.
 *
 * Dans Horos (menu « Add FlyThru Point »), le médecin place une suite de points
 * de contrôle dans le volume (lumière d'un côlon, d'une bronche, d'un vaisseau).
 * On en dérive une COURBE LISSE qui passe EXACTEMENT par chaque point, sur
 * laquelle la caméra avance ensuite image par image. La caméra regarde dans le
 * sens de la TANGENTE de la courbe.
 *
 * On utilise une spline de Catmull-Rom (variante centripète bornée à uniforme)
 * car elle interpole ses points de contrôle (la courbe passe par eux, contrai-
 * rement à une Bézier/B-spline) et reste C1-continue → pas de cassure visible
 * pendant le vol.
 *
 * Fonctions 100 % PURES et déterministes : que des nombres, aucune dépendance
 * VTK / Cornerstone / DOM. Testables hors navigateur.
 *
 * ── Rappel Catmull-Rom (forme uniforme) ─────────────────────────────────────
 * Pour un segment entre P1 et P2, encadré par P0 et P3, et t ∈ [0,1] :
 *   p(t) = 0.5 · [ 2·P1
 *               + (−P0 + P2)·t
 *               + (2·P0 − 5·P1 + 4·P2 − P3)·t²
 *               + (−P0 + 3·P1 − 3·P2 + P3)·t³ ]
 * Aux extrémités on duplique le point terminal (P0 = P1 au départ, P3 = P2 à la
 * fin) → la courbe démarre et finit pile sur le premier / dernier point.
 */

/** Point 3D (monde, mm). Tuple mutable pour rester simple côté appelant. */
export type Point3 = [number, number, number];

/** Soustraction a − b. */
function sub(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Distance euclidienne entre deux points. */
function dist(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Norme euclidienne d'un vecteur. */
function norm(v: Point3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Évalue un segment Catmull-Rom uniforme défini par 4 points (p0..p3) en
 * t ∈ [0,1]. La courbe interpole p1 (t=0) et p2 (t=1).
 */
function evalSegment(
  p0: Point3,
  p1: Point3,
  p2: Point3,
  p3: Point3,
  t: number
): Point3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: Point3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] =
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  }
  return out;
}

/**
 * Construit la spline de Catmull-Rom passant par tous les `points` de contrôle.
 *
 * @param points Points de contrôle (≥ 1). La courbe les interpole tous.
 * @param samplesPerSegment Nombre d'INTERVALLES échantillonnés par segment
 *   (entre deux points consécutifs). ≥ 1. Plus il est grand, plus le vol est
 *   fluide. Borné à un entier ≥ 1.
 * @returns Liste ordonnée de points le long de la courbe, du premier au dernier
 *   point de contrôle inclus. Sans doublon aux jonctions de segments.
 *
 * Cas dégénérés :
 *   • 0 point  → [] ;
 *   • 1 point  → [ce point] ;
 *   • 2 points → segment, extrémités dupliquées pour les tangentes.
 */
export function catmullRomSpline(
  points: Point3[],
  samplesPerSegment: number
): Point3[] {
  const n = points.length;
  if (n === 0) return [];
  // Copie défensive des points (on ne mute jamais l'entrée).
  if (n === 1) return [[...points[0]] as Point3];

  // Au moins 1 intervalle par segment ; on arrondit vers le bas.
  const steps = Math.max(1, Math.floor(samplesPerSegment));

  const result: Point3[] = [];
  // Pour chaque segment [points[i], points[i+1]], on prend les voisins i-1 / i+2
  // en dupliquant les bornes du tableau.
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1 < 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 > n - 1 ? n - 1 : i + 2];

    // On inclut t=0 uniquement pour le premier segment, sinon ce serait le
    // doublon de la fin du segment précédent. t va de 0/1 à steps.
    const startK = i === 0 ? 0 : 1;
    for (let k = startK; k <= steps; k++) {
      const t = k / steps;
      result.push(evalSegment(p0, p1, p2, p3, t));
    }
  }
  return result;
}

/**
 * Tangentes UNITAIRES le long d'un chemin échantillonné (sens de marche de la
 * caméra). Calculées par différences finies centrées (avant/arrière aux bords).
 *
 * @param path Chemin échantillonné (typiquement la sortie de catmullRomSpline).
 * @returns Une tangente par point. Vecteur nul [0,0,0] là où deux points
 *   voisins coïncident (pas de direction définie).
 *
 * Cas dégénérés :
 *   • 0 point → [] ;
 *   • 1 point → [[0,0,0]] (aucune direction) ;
 */
export function pathTangents(path: Point3[]): Point3[] {
  const m = path.length;
  if (m === 0) return [];
  if (m === 1) return [[0, 0, 0]];

  const tangents: Point3[] = [];
  for (let i = 0; i < m; i++) {
    let d: Point3;
    if (i === 0) {
      d = sub(path[1], path[0]); // différence avant
    } else if (i === m - 1) {
      d = sub(path[m - 1], path[m - 2]); // différence arrière
    } else {
      d = sub(path[i + 1], path[i - 1]); // différence centrée
    }
    const l = norm(d);
    tangents.push(l === 0 ? [0, 0, 0] : [d[0] / l, d[1] / l, d[2] / l]);
  }
  return tangents;
}

/**
 * Longueur totale de la POLYLIGNE reliant les points (somme des distances
 * euclidiennes entre points consécutifs).
 *
 * Appliquée aux points de contrôle, c'est une borne inférieure (corde) de la
 * vraie longueur de la spline ; appliquée à un chemin densément échantillonné
 * (sortie de catmullRomSpline), elle l'approche d'aussi près qu'on le souhaite.
 *
 * @returns 0 pour 0 ou 1 point.
 */
export function pathLength(points: Point3[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += dist(points[i], points[i + 1]);
  }
  return total;
}
