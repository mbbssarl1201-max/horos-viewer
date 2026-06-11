// Outil de caviardage (redaction) des PHI « brûlés » dans les pixels.
//
// Certaines images DICOM (échographie, capture secondaire) portent le nom du
// patient, des dates, etc. incrustés dans l'image elle-même. Le seul moyen
// fiable de les retirer est un caviardage MANUEL : l'utilisateur trace des
// rectangles que l'on remplit en noir opaque, et que l'on RECOMPOSE sur toute
// image exportée/capturée (PNG) avant qu'elle ne quitte le visualiseur.
//
// Choix d'implémentation : les rectangles sont stockés en coordonnées
// FRACTIONNAIRES (0..1) relatives au viewport affiché. Ainsi ils sont
// indépendants de la résolution : on peut les recomposer sur le canvas
// onscreen quelle que soit sa taille de pixels réelle (devicePixelRatio,
// downscale Cornerstone, etc.).

/** Rectangle de caviardage en fractions (0..1) du viewport. */
export interface RedactionRect {
  /** Bord gauche, fraction de la largeur (0..1). */
  x: number;
  /** Bord haut, fraction de la hauteur (0..1). */
  y: number;
  /** Largeur, fraction (0..1). */
  w: number;
  /** Hauteur, fraction (0..1). */
  h: number;
}

/** Borne une valeur dans [min, max]. */
function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/**
 * Normalise un glissé (point de départ → point d'arrivée) en un rectangle
 * {x,y,w,h} fractionnaire, borné à [0,1]. Gère le glissé dans n'importe quel
 * sens (haut-gauche → bas-droite ou l'inverse). `containerW`/`containerH` sont
 * les dimensions affichées (CSS px) du conteneur.
 */
export function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  containerW: number,
  containerH: number
): RedactionRect {
  if (containerW <= 0 || containerH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  // Coins min/max (sens du glissé indifférent), bornés au conteneur.
  const x0 = clamp(Math.min(startX, endX), 0, containerW);
  const y0 = clamp(Math.min(startY, endY), 0, containerH);
  const x1 = clamp(Math.max(startX, endX), 0, containerW);
  const y1 = clamp(Math.max(startY, endY), 0, containerH);
  return {
    x: x0 / containerW,
    y: y0 / containerH,
    w: (x1 - x0) / containerW,
    h: (y1 - y0) / containerH,
  };
}

/**
 * Vrai si le rectangle est trop petit pour être un caviardage utile (clic
 * accidentel). Seuil exprimé en fraction (défaut 0,5 % de chaque côté).
 */
export function isNegligibleRect(r: RedactionRect, minFrac = 0.005): boolean {
  return r.w < minFrac || r.h < minFrac;
}

/**
 * Convertit un rectangle fractionnaire en pixels entiers pour un canvas/zone
 * de dimensions données. Le résultat est borné à la zone et arrondi de façon
 * à couvrir AU MOINS la zone fractionnaire (floor sur l'origine, ceil sur la
 * taille) — il ne faut jamais laisser dépasser du PHI sur un bord.
 */
export function rectToPixels(
  r: RedactionRect,
  pixelW: number,
  pixelH: number
): { x: number; y: number; w: number; h: number } {
  const x = Math.floor(clamp(r.x, 0, 1) * pixelW);
  const y = Math.floor(clamp(r.y, 0, 1) * pixelH);
  // Bord droit/bas calculés puis ceil, pour ne jamais sous-couvrir.
  const right = Math.ceil(clamp(r.x + r.w, 0, 1) * pixelW);
  const bottom = Math.ceil(clamp(r.y + r.h, 0, 1) * pixelH);
  return {
    x,
    y,
    w: Math.max(0, right - x),
    h: Math.max(0, bottom - y),
  };
}

/**
 * Type minimal d'un contexte 2D dont on a besoin pour le caviardage. Permet de
 * tester avec un faux contexte sans dépendre d'un vrai DOM/canvas.
 */
export interface RedactionContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Peint en NOIR OPAQUE chaque rectangle de caviardage sur le contexte 2D
 * fourni (dimensions `pixelW`×`pixelH`). C'est l'opération qui garantit que le
 * PHI a disparu de l'image avant export : on écrit des pixels noirs opaques
 * par-dessus la zone, de façon irréversible dans le bitmap de sortie.
 *
 * Renvoie le nombre de rectangles effectivement peints (utile pour les tests).
 */
export function applyRedactions(
  ctx: RedactionContext2D,
  rects: readonly RedactionRect[],
  pixelW: number,
  pixelH: number
): number {
  if (pixelW <= 0 || pixelH <= 0) return 0;
  const prevFill = ctx.fillStyle;
  ctx.fillStyle = "#000000";
  let painted = 0;
  for (const r of rects) {
    const p = rectToPixels(r, pixelW, pixelH);
    if (p.w <= 0 || p.h <= 0) continue;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    painted += 1;
  }
  ctx.fillStyle = prevFill;
  return painted;
}

/**
 * Recompose les caviardages sur un canvas SOURCE et renvoie un NOUVEAU canvas
 * (copie) avec le PHI masqué — sans modifier la source. Utilisé au moment de
 * la capture/export pour garantir que l'image qui sort est caviardée.
 *
 * Si aucun rectangle n'est fourni, renvoie la source telle quelle (pas de copie
 * inutile). Renvoie `null` si le contexte 2D n'est pas disponible.
 */
export function compositeRedactedCanvas(
  source: HTMLCanvasElement,
  rects: readonly RedactionRect[]
): HTMLCanvasElement | null {
  if (rects.length === 0) return source;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  // 1) copie de l'image source, 2) caviardage opaque par-dessus.
  ctx.drawImage(source, 0, 0);
  applyRedactions(ctx, rects, out.width, out.height);
  return out;
}
