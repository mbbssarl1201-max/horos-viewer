// Helpers PURS de transformation de viewport, façon Horos (rotation par pas de
// 90°, retournement horizontal/vertical, échelle « taille réelle » 1:1 et
// ajustement à la fenêtre, presets de zoom).
//
// Tout est PUR et déterministe : aucune dépendance React / DOM / Cornerstone /
// vtk, aucune I/O. On ne manipule que des nombres et des petits objets d'état,
// ce qui rend l'ensemble testable hors navigateur.
//
// Convention d'angles : DEGRÉS, sens horaire, normalisés dans [0, 360[.

/** État de retournement (miroir) d'un viewport. */
export interface FlipState {
  /** Retournement horizontal (miroir gauche/droite). */
  h: boolean;
  /** Retournement vertical (miroir haut/bas). */
  v: boolean;
}

/** Paramètres complets d'une transformation de viewport. */
export interface ViewportTransform {
  /** Rotation en degrés, normalisée [0, 360[. */
  rotation: number;
  /** Retournement horizontal. */
  flipH: boolean;
  /** Retournement vertical. */
  flipV: boolean;
  /** Facteur de zoom (1 = 100 %). */
  zoom: number;
}

/**
 * Matrice affine 2D sans translation, sous forme des 4 coefficients de la
 * sous-matrice linéaire [[a, c], [b, d]] (mêmes conventions que le `transform`
 * CSS/canvas `matrix(a, b, c, d, e, f)`, ici e = f = 0). PURE : aucune unité
 * pixel, l'appelant ajoute la translation de centrage côté rendu.
 */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Presets de zoom proposés à l'utilisateur, en pourcentage. */
export const ZOOM_PRESETS: readonly number[] = [25, 50, 100, 200, 300];

/** Normalise un angle en degrés dans [0, 360[ (tolère NaN → 0). */
function normalizeDegrees(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = deg % 360;
  // `+ 0` élimine le -0 produit par le modulo (ex. -360 % 360 = -0).
  return (r < 0 ? r + 360 : r) + 0;
}

/**
 * Rotation suivante après application d'un delta (en degrés). Le résultat est
 * toujours normalisé dans [0, 360[. Gère les deltas négatifs (rotation antihoraire)
 * et les grands deltas (multiples tours). Entrées non finies traitées comme 0.
 */
export function nextRotation(deg: number, delta: number): number {
  const base = Number.isFinite(deg) ? deg : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  return normalizeDegrees(base + step);
}

/**
 * Bascule un axe de retournement et renvoie un NOUVEL état (immuable, l'entrée
 * n'est jamais mutée). `axis` vaut 'h' (horizontal) ou 'v' (vertical).
 */
export function toggleFlip(state: FlipState, axis: "h" | "v"): FlipState {
  return {
    h: axis === "h" ? !state.h : state.h,
    v: axis === "v" ? !state.v : state.v,
  };
}

/**
 * Facteur d'échelle pour un affichage « taille réelle » 1:1 (un millimètre du
 * patient = un millimètre à l'écran), à partir de l'espacement pixel de l'image
 * (mm/pixel, PixelSpacing DICOM) et de la résolution écran en DPI (pixels/pouce).
 *
 *   pixels_écran_par_mm = DPI / 25.4
 *   facteur = (DPI / 25.4) × pixelSpacingMm
 *
 * où `facteur` est le nombre de pixels écran à afficher par pixel image pour
 * obtenir le 1:1 physique. Renvoie `null` si une entrée est absente / ≤ 0 / non
 * finie (on ne peut pas garantir le 1:1 → l'appelant masque l'option).
 */
export function scaleForActualSize(
  pixelSpacingMm: number,
  screenDpi: number
): number | null {
  if (
    !Number.isFinite(pixelSpacingMm) ||
    !Number.isFinite(screenDpi) ||
    pixelSpacingMm <= 0 ||
    screenDpi <= 0
  ) {
    return null;
  }
  const MM_PER_INCH = 25.4;
  return (screenDpi / MM_PER_INCH) * pixelSpacingMm;
}

/**
 * Facteur d'échelle pour ajuster une image (imgW×imgH) à une fenêtre
 * (viewW×viewH) sans la déformer ni la rogner (« fit » = contain) : on prend la
 * plus petite des deux échelles. Renvoie `null` si une dimension est ≤ 0 / non
 * finie. Un facteur < 1 réduit, > 1 agrandit jusqu'à remplir au mieux.
 */
export function scaleToFit(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number
): number | null {
  if (
    !Number.isFinite(imgW) ||
    !Number.isFinite(imgH) ||
    !Number.isFinite(viewW) ||
    !Number.isFinite(viewH) ||
    imgW <= 0 ||
    imgH <= 0 ||
    viewW <= 0 ||
    viewH <= 0
  ) {
    return null;
  }
  return Math.min(viewW / imgW, viewH / imgH);
}

/**
 * Compose une transformation de viewport en une matrice affine linéaire 2D
 * (rotation + retournements + zoom), prête à être consommée par un rendu
 * canvas/CSS. PURE : pas de translation (centrage laissé à l'appelant).
 *
 * Ordre des opérations (du référentiel image vers l'écran) :
 *   1. retournement (miroir) sur chaque axe : sx = flipH ? -1 : 1, idem sy
 *   2. rotation horaire de `rotation` degrés
 *   3. mise à l'échelle uniforme par `zoom`
 *
 * Matrice de rotation horaire d'angle θ (axe Y écran vers le bas) :
 *   [[cosθ, -sinθ], [sinθ, cosθ]]
 * combinée à l'échelle diagonale diag(zoom·sx, zoom·sy) appliquée AVANT la
 * rotation : M = R(θ) · S.
 *
 * Le `zoom` est borné à ≥ 0 ; non fini → 1. Rotation normalisée [0,360[.
 */
export function composeTransform(t: ViewportTransform): AffineMatrix {
  const rotation = normalizeDegrees(t.rotation);
  const zoom = Number.isFinite(t.zoom) ? Math.max(0, t.zoom) : 1;
  const sx = (t.flipH ? -1 : 1) * zoom;
  const sy = (t.flipV ? -1 : 1) * zoom;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // M = R(θ) · diag(sx, sy)
  //   = [[cos·sx, -sin·sy], [sin·sx, cos·sy]]
  // En convention matrix(a, b, c, d) : a, b = 1re colonne ; c, d = 2e colonne.
  return {
    a: cos * sx,
    b: sin * sx,
    c: -sin * sy,
    d: cos * sy,
  };
}
