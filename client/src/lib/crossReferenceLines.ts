// Lignes de référence croisées (« localizer » / cross-reference lines).
//
// Quand on affiche deux coupes DICOM de plans différents (p. ex. un axial et un
// sagittal de la même étude), on veut tracer SUR la coupe cible la trace du plan
// source : la droite d'intersection des deux plans, projetée en coordonnées
// pixel de la coupe cible. C'est le repère que les radiologues attendent (comme
// dans Horos / OsiriX).
//
// ── Géométrie DICOM ─────────────────────────────────────────────────────────
// Un plan d'image est défini par :
//   • IOP (ImageOrientationPatient, 0020,0037) : 6 valeurs = direction de la
//     ligne (rowDir, axe +X pixel) puis direction de la colonne (colDir, axe +Y
//     pixel), en coordonnées patient (LPS, mm).
//   • IPP (ImagePositionPatient, 0020,0032) : 3 valeurs = position (mm) du CENTRE
//     du pixel (0,0) — coin haut-gauche.
//   • rows / cols : nombre de lignes / colonnes.
//   • spacing [rowSpacing, colSpacing] (PixelSpacing, 0028,0030) : pas en mm.
//
// Position patient d'un pixel (col i, row j) :
//   P(i,j) = IPP + i·colSpacing·rowDir + j·rowSpacing·colDir
// La normale du plan vaut rowDir × colDir.
//
// L'intersection de deux plans est une droite de direction n_src × n_tgt. On la
// matérialise dans le plan CIBLE, on la convertit en coordonnées pixel cible,
// puis on la CLIPPE au rectangle [0,cols]×[0,rows] de la coupe cible. Si les
// plans sont parallèles, ou si la droite ne traverse pas le cadre cible, on
// renvoie `null` (rien à tracer).
//
// PUR : que des nombres, aucune dépendance DOM / Cornerstone / vtk.

/** Vecteur 3D en coordonnées patient (mm). */
export type Vec3 = readonly [number, number, number];

/** Point 2D en coordonnées pixel (col = x, row = y). */
export type Vec2 = readonly [number, number];

/** Tags bruts d'un plan DICOM (tels que lus du dataset). */
export interface DicomPlaneInput {
  /** ImageOrientationPatient : 6 valeurs [rowDir(3), colDir(3)]. */
  iop: readonly number[];
  /** ImagePositionPatient : 3 valeurs (mm). */
  ipp: readonly number[];
  /** Nombre de lignes (hauteur). */
  rows: number;
  /** Nombre de colonnes (largeur). */
  cols: number;
  /** PixelSpacing [rowSpacing, colSpacing] (mm). */
  spacing: readonly [number, number] | readonly number[];
}

/** Plan d'image normalisé, prêt pour les calculs géométriques. */
export interface ImagePlane {
  /** Origine = centre du pixel (0,0), en patient (mm). */
  origin: Vec3;
  /** Direction unitaire de la ligne (axe +X pixel / colonnes). */
  rowDir: Vec3;
  /** Direction unitaire de la colonne (axe +Y pixel / lignes). */
  colDir: Vec3;
  /** Normale unitaire (rowDir × colDir). */
  normal: Vec3;
  /** Nombre de lignes. */
  rows: number;
  /** Nombre de colonnes. */
  cols: number;
  /** Pas en mm le long d'une ligne (entre colonnes). */
  colSpacing: number;
  /** Pas en mm le long d'une colonne (entre lignes). */
  rowSpacing: number;
}

/** Segment résultant en coordonnées pixel de la coupe cible. */
export interface IntersectionSegment {
  /** Extrémité de départ [col, row]. */
  start: Vec2;
  /** Extrémité d'arrivée [col, row]. */
  end: Vec2;
}

/** Tolérance numérique (les coordonnées DICOM sont en mm). */
const EPS = 1e-6;

/** Produit scalaire. */
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Produit vectoriel a × b. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Différence a − b. */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Somme a + b. */
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Mise à l'échelle s·a. */
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Norme euclidienne. */
export function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/** Vecteur unitaire ; renvoie [0,0,0] pour un vecteur (quasi) nul. */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < EPS) return [0, 0, 0];
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** Convertit une entrée brute (number | string) en nombre fini, ou `null`. */
function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Construit un `ImagePlane` à partir des tags DICOM bruts. Renvoie `null` si les
 * données sont insuffisantes / incohérentes :
 *   • IOP doit fournir 6 nombres finis dont rowDir et colDir non nuls ;
 *   • IPP doit fournir 3 nombres finis ;
 *   • rows / cols entiers > 0 ;
 *   • spacing : 2 nombres finis > 0.
 *
 * rowDir et colDir sont re-normalisés (les IOP DICOM le sont déjà en théorie,
 * mais on ne fait pas confiance aveuglément aux datasets).
 */
export function planeFromDicom(input: DicomPlaneInput): ImagePlane | null {
  const { iop, ipp, rows, cols, spacing } = input;
  if (!iop || iop.length < 6 || !ipp || ipp.length < 3 || !spacing) {
    return null;
  }

  const iopNums: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = finite(iop[i]);
    if (n === null) return null;
    iopNums.push(n);
  }
  const ippNums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const n = finite(ipp[i]);
    if (n === null) return null;
    ippNums.push(n);
  }

  const rowSpacing = finite(spacing[0]);
  const colSpacing = finite(spacing[1]);
  if (rowSpacing === null || colSpacing === null) return null;
  if (rowSpacing <= 0 || colSpacing <= 0) return null;

  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return null;
  if (rows <= 0 || cols <= 0) return null;

  const rawRow: Vec3 = [iopNums[0], iopNums[1], iopNums[2]];
  const rawCol: Vec3 = [iopNums[3], iopNums[4], iopNums[5]];
  if (norm(rawRow) < EPS || norm(rawCol) < EPS) return null;

  const rowDir = normalize(rawRow);
  const colDir = normalize(rawCol);
  const normal = normalize(cross(rowDir, colDir));
  if (norm(normal) < EPS) return null; // rowDir ∥ colDir → plan dégénéré

  return {
    origin: [ippNums[0], ippNums[1], ippNums[2]],
    rowDir,
    colDir,
    normal,
    rows: Math.floor(rows),
    cols: Math.floor(cols),
    colSpacing,
    rowSpacing,
  };
}

/**
 * Projette un point patient `p` (mm) en coordonnées pixel (col, row) du plan.
 * On résout p − origin = i·colSpacing·rowDir + j·rowSpacing·colDir dans le plan.
 * rowDir et colDir n'étant pas forcément orthogonaux en théorie (ils le sont en
 * pratique DICOM), on projette sur chaque axe via le produit scalaire — exact si
 * orthonormés, ce qui est le cas normal.
 */
export function patientToPixel(plane: ImagePlane, p: Vec3): Vec2 {
  const d = sub(p, plane.origin);
  const col = dot(d, plane.rowDir) / plane.colSpacing;
  const row = dot(d, plane.colDir) / plane.rowSpacing;
  return [col, row];
}

/**
 * Calcule la droite d'intersection des deux plans, sous forme paramétrique
 * point + direction (en coordonnées patient). Renvoie `null` si les plans sont
 * parallèles (normales colinéaires).
 *
 * Méthode : direction = n_src × n_tgt. Un point de la droite est obtenu en
 * résolvant le système des deux équations de plan ; on choisit le point de la
 * droite le plus proche de l'origine via la formule classique
 *   p0 = ( (d1·(n2×dir)) · n1 + (d2·(n1×dir)) · n2 ) / |dir|²  (forme adaptée),
 * ici implémentée de façon robuste avec d_i = n_i · origin_i.
 */
export function planeIntersectionRay(
  source: ImagePlane,
  target: ImagePlane
): { point: Vec3; direction: Vec3 } | null {
  const n1 = source.normal;
  const n2 = target.normal;
  const dir = cross(n1, n2);
  const dirLen2 = dot(dir, dir);
  if (dirLen2 < EPS * EPS) return null; // plans parallèles

  // Constantes des équations de plan : n · x = d.
  const d1 = dot(n1, source.origin);
  const d2 = dot(n2, target.origin);

  // p0 = ( d1 (n2×dir) + d2 (dir×n1) ) / |dir|²
  const term1 = scale(cross(n2, dir), d1);
  const term2 = scale(cross(dir, n1), d2);
  const point = scale(add(term1, term2), 1 / dirLen2);

  return { point, direction: dir };
}

/**
 * Clippe le segment paramétré P(t) = a + t·dir (a et dir en 2D pixel) au
 * rectangle [0,cols]×[0,rows] (algorithme de Liang–Barsky). Renvoie l'intervalle
 * [tmin, tmax] de t à l'intérieur du cadre, ou `null` si le segment ne touche
 * pas le cadre.
 */
function liangBarsky(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  cols: number,
  rows: number
): { tmin: number; tmax: number } | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - 0, cols - ax, ay - 0, rows - ay];

  for (let k = 0; k < 4; k++) {
    if (Math.abs(p[k]) < EPS) {
      // Droite parallèle à ce bord : hors cadre si q < 0.
      if (q[k] < 0) return null;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t0 > t1) return null;
  return { tmin: t0, tmax: t1 };
}

/**
 * Calcule la ligne d'intersection du plan `source` projetée dans les
 * coordonnées pixel du plan `target`, clippée au cadre de la coupe cible.
 *
 * Renvoie `{ start, end }` en pixels [col, row], ou `null` si :
 *   • les plans sont parallèles (pas d'intersection unique) ;
 *   • la droite d'intersection ne traverse pas le cadre de la coupe cible ;
 *   • la projection est dégénérée (direction nulle en 2D).
 *
 * Note : on borne le paramètre patient sur une longueur généreuse autour du
 * point de référence pour obtenir deux points 2D distincts, puis on clippe en
 * 2D — robuste quelle que soit l'échelle.
 */
export function intersectionLine(
  source: ImagePlane,
  target: ImagePlane
): IntersectionSegment | null {
  const ray = planeIntersectionRay(source, target);
  if (!ray) return null;

  // Deux points patient distincts sur la droite d'intersection.
  const pA = ray.point;
  const pB = add(ray.point, ray.direction);

  // Projection dans le repère pixel de la coupe cible.
  const a = patientToPixel(target, pA);
  const b = patientToPixel(target, pB);

  const ax = a[0];
  const ay = a[1];
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS * EPS) return null; // la droite est ⟂ au plan cible (point)

  const clip = liangBarsky(ax, ay, dx, dy, target.cols, target.rows);
  if (!clip) return null;

  const start: Vec2 = [ax + clip.tmin * dx, ay + clip.tmin * dy];
  const end: Vec2 = [ax + clip.tmax * dx, ay + clip.tmax * dy];

  // Segment de longueur nulle après clip (tangent à un coin) → rien à tracer.
  const sdx = end[0] - start[0];
  const sdy = end[1] - start[1];
  if (sdx * sdx + sdy * sdy < EPS * EPS) return null;

  return { start, end };
}
