// Planification d'export ciné → vidéo (menu « Export to Movie » de Horos).
//
// Ce module est PUR : il GÉNÈRE le plan d'encodage (cadence, durée, arguments
// ffmpeg) mais n'exécute RIEN. Aucune dépendance React / DOM / Cornerstone /
// ffmpeg : on raisonne uniquement sur des nombres et des chaînes. L'appelant
// (UI ou worker) passe ces arguments à un ffmpeg.wasm / sous-processus.
//
// Modèle d'entrée supposé : les coupes du ciné ont déjà été rendues en une
// suite d'images numérotées (frame-%05d.png). ffmpeg les assemble à la cadence
// voulue. On expose donc des arguments « image2 → mp4/gif » déterministes.
//
// Choix de robustesse : aucune exception. Les entrées dégénérées (0 image,
// fps ≤ 0, dimensions ≤ 0) sont bornées à des valeurs sûres pour que le plan
// reste cohérent (durée ≥ 0, dimensions paires pour H.264, etc.).

/** Formats vidéo proposés dans l'UI d'export. */
export const MOVIE_FORMATS = ["mp4", "gif"] as const;

/** Type d'un format vidéo supporté. */
export type MovieFormat = (typeof MOVIE_FORMATS)[number];

/** Paramètres d'entrée de la planification d'export. */
export interface EncodePlanInput {
  /** Nombre d'images (frames) à assembler. */
  frameCount: number;
  /** Cadence souhaitée en images/seconde. */
  fps: number;
  /** Format de sortie. */
  format: MovieFormat;
  /** Largeur de sortie en pixels. */
  width: number;
  /** Hauteur de sortie en pixels. */
  height: number;
}

/** Plan d'encodage : cadence/durée effectives + arguments ffmpeg prêts. */
export interface EncodePlan {
  /** Cadence effective (bornée), en images/seconde. */
  fps: number;
  /** Durée de la vidéo en secondes (frameCount / fps). */
  duration: number;
  /** Arguments ffmpeg, dans l'ordre, sans le binaire « ffmpeg » lui-même. */
  ffmpegArgs: string[];
}

/** Cadence minimale acceptée (évite division par zéro / durée infinie). */
const MIN_FPS = 1;
/** Cadence maximale raisonnable pour un ciné médical. */
const MAX_FPS = 60;

/** Borne une valeur dans [min, max] ; NaN → min. */
function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/**
 * Normalise une cadence : finie, dans [MIN_FPS, MAX_FPS], arrondie à l'entier
 * supérieur le plus proche n'est PAS souhaitable (24 → 24) ; on conserve donc
 * la valeur telle quelle après bornage (les fps fractionnaires sont licites).
 */
export function normalizeFps(fps: number): number {
  return clamp(fps, MIN_FPS, MAX_FPS);
}

/**
 * Force une dimension à être un entier PAIR ≥ 2. H.264 (yuv420p) exige des
 * dimensions paires ; on arrondit vers le bas au pair le plus proche, plancher
 * à 2. Dimensions non finies / ≤ 0 → 2.
 */
export function evenDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 2;
  const floored = Math.floor(value);
  const even = floored - (floored % 2);
  return even < 2 ? 2 : even;
}

/**
 * Estime le nombre d'images d'un ciné à partir d'un nombre de coupes et d'une
 * plage [début, fin] (indices INCLUSIFS, base 0). Sans plage valide, renvoie
 * `sliceCount` borné à ≥ 0. Utilisé par l'UI pour annoncer la taille de l'export
 * avant de lancer le rendu.
 *
 * - sliceCount ≤ 0 → 0.
 * - range absent → sliceCount entier.
 * - range fourni : on borne [start,end] dans [0, sliceCount-1], on remet dans
 *   l'ordre si inversé, et on compte les images incluses (end - start + 1).
 */
export function estimateFrames(
  sliceCount: number,
  range?: { start: number; end: number }
): number {
  if (!Number.isFinite(sliceCount) || sliceCount <= 0) return 0;
  const total = Math.floor(sliceCount);
  if (!range) return total;
  const last = total - 1;
  let start = clamp(Math.floor(range.start), 0, last);
  let end = clamp(Math.floor(range.end), 0, last);
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return end - start + 1;
}

/**
 * Construit le plan d'encodage complet (cadence, durée, arguments ffmpeg).
 *
 * Hypothèse d'entrée ffmpeg : une séquence d'images PNG nommées `frame-%05d.png`
 * lue via le démultiplexeur « image2 » à la cadence demandée. La sortie est
 * écrite dans `output.<ext>`.
 *
 * - mp4 : H.264 (libx264), pixel format yuv420p (compatibilité large), CRF 18
 *   (quasi-sans perte visuelle pour de l'imagerie), dimensions FORCÉES paires.
 * - gif : palette générée à la volée (palettegen/paletteuse via filtre split)
 *   pour une qualité correcte sans table externe ; boucle infinie.
 *
 * Robustesse : frameCount/fps/dimensions dégénérés sont bornés. La durée vaut
 * frameCount / fps (≥ 0). Aucune exception.
 */
export function buildEncodePlan(input: EncodePlanInput): EncodePlan {
  const fps = normalizeFps(input.fps);
  const frameCount =
    Number.isFinite(input.frameCount) && input.frameCount > 0
      ? Math.floor(input.frameCount)
      : 0;
  const width = evenDimension(input.width);
  const height = evenDimension(input.height);
  const duration = frameCount / fps;

  // Échelle commune : force les dimensions de sortie (paires) quel que soit
  // l'input. `scale` placé en tête de chaîne de filtres.
  const scale = `scale=${width}:${height}`;

  let ffmpegArgs: string[];
  if (input.format === "gif") {
    // Palette à la volée : split → palettegen / paletteuse.
    const filter =
      `${scale},split[s0][s1];` + `[s0]palettegen[p];` + `[s1][p]paletteuse`;
    ffmpegArgs = [
      "-framerate",
      String(fps),
      "-i",
      "frame-%05d.png",
      "-vf",
      filter,
      "-loop",
      "0",
      "output.gif",
    ];
  } else {
    // mp4 / H.264.
    ffmpegArgs = [
      "-framerate",
      String(fps),
      "-i",
      "frame-%05d.png",
      "-vf",
      `${scale},format=yuv420p`,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-movflags",
      "+faststart",
      "output.mp4",
    ];
  }

  return { fps, duration, ffmpegArgs };
}
