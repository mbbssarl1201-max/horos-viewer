// Tables de palettes couleur (CLUT — Color Look-Up Tables) façon Horos.
//
// Une palette transforme une valeur scalaire NORMALISÉE [0,1] (typiquement le
// niveau de gris après fenêtrage window/level) en un triplet RGB [0..255]. On
// retrouve les palettes classiques du visualiseur Horos : niveaux de gris (et
// son inverse), « Hot Iron », « PET », « Rainbow », « Flow », « Spring », et
// les trois canaux purs Rouge/Vert/Bleu.
//
// Code 100 % PUR et déterministe : aucune dépendance React / DOM / Cornerstone /
// vtk, aucune I/O. On ne manipule que des nombres et des Uint8ClampedArray, ce
// qui rend l'ensemble testable hors navigateur.
//
// Choix d'implémentation : chaque palette est définie par une fonction
// `(t: number) => RGB` sur t∈[0,1]. On en dérive à la demande une LUT de 256
// entrées (256×3 octets) via `getColormapLut`, format directement consommable
// par un rendu canvas/WebGL. Les fonctions sont pures et sans état, la LUT est
// donc reproductible à l'identique.

/** Triplet RGB, chaque composante entière dans [0..255]. */
export type RGB = [number, number, number];

/** Entrée d'inventaire d'une palette : identifiant interne + libellé affichable. */
export interface ColormapInfo {
  /** Nom interne / clé (ex. « Hot Iron »). */
  name: string;
  /** Libellé pour l'UI (ici identique au nom, façon Horos). */
  label: string;
}

/** Borne une valeur dans [min, max] ; NaN → min (sûreté). */
function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** Borne t dans [0,1] (NaN → 0). */
function clamp01(t: number): number {
  return clamp(t, 0, 1);
}

/** Arrondit et borne une composante dans [0..255]. */
function toByte(v: number): number {
  return clamp(Math.round(v), 0, 255);
}

/**
 * Interpolation linéaire entre des « stops » colorés répartis uniformément sur
 * [0,1]. Avec n stops, le stop i est positionné en i/(n-1). Sert à construire
 * les rampes (Hot Iron, PET, Rainbow, Flow…). Un seul stop → couleur constante.
 */
function rampFromStops(stops: readonly RGB[]): (t: number) => RGB {
  const n = stops.length;
  return (t: number): RGB => {
    if (n === 0) return [0, 0, 0];
    if (n === 1)
      return [toByte(stops[0][0]), toByte(stops[0][1]), toByte(stops[0][2])];
    const x = clamp01(t) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i];
    const b = stops[i + 1];
    return [
      toByte(a[0] + (b[0] - a[0]) * f),
      toByte(a[1] + (b[1] - a[1]) * f),
      toByte(a[2] + (b[2] - a[2]) * f),
    ];
  };
}

/**
 * Définition de chaque palette : une fonction pure t∈[0,1] → RGB. Les rampes
 * suivent les CLUT historiques d'Horos (valeurs choisies pour reproduire
 * l'aspect visuel, pas une norme officielle).
 */
const COLORMAP_FNS: Record<string, (t: number) => RGB> = {
  // Niveaux de gris : noir → blanc.
  "B&W": t => {
    const g = toByte(clamp01(t) * 255);
    return [g, g, g];
  },
  // Niveaux de gris inversés : blanc → noir.
  "B&W Inverse": t => {
    const g = toByte((1 - clamp01(t)) * 255);
    return [g, g, g];
  },
  // Hot Iron : noir → rouge → orange → jaune → blanc (corps chaud).
  "Hot Iron": rampFromStops([
    [0, 0, 0],
    [127, 0, 0],
    [255, 90, 0],
    [255, 200, 0],
    [255, 255, 255],
  ]),
  // PET (« PET » d'Horos) : noir → bleu → magenta → rouge → jaune → blanc.
  PET: rampFromStops([
    [0, 0, 0],
    [0, 0, 128],
    [128, 0, 128],
    [255, 0, 0],
    [255, 255, 0],
    [255, 255, 255],
  ]),
  // Rainbow : bleu → cyan → vert → jaune → rouge (arc-en-ciel classique).
  Rainbow: rampFromStops([
    [0, 0, 255],
    [0, 255, 255],
    [0, 255, 0],
    [255, 255, 0],
    [255, 0, 0],
  ]),
  // Flow (vélocité IRM) : bleu → noir → rouge (bidirectionnel centré).
  Flow: rampFromStops([
    [0, 0, 255],
    [0, 0, 0],
    [255, 0, 0],
  ]),
  // Spring : magenta → jaune (cyan absent), façon colormap « spring ».
  Spring: rampFromStops([
    [255, 0, 255],
    [255, 255, 0],
  ]),
  // Canal Rouge pur : noir → rouge.
  Red: t => [toByte(clamp01(t) * 255), 0, 0],
  // Canal Vert pur : noir → vert.
  Green: t => [0, toByte(clamp01(t) * 255), 0],
  // Canal Bleu pur : noir → bleu.
  Blue: t => [0, 0, toByte(clamp01(t) * 255)],
};

/** Inventaire ordonné des palettes disponibles (name + label). */
export const COLORMAPS: readonly ColormapInfo[] = Object.keys(COLORMAP_FNS).map(
  name => ({ name, label: name })
);

/** Nombre d'entrées d'une LUT (résolution 8 bits classique). */
export const LUT_SIZE = 256;

/** Vrai si `name` désigne une palette connue. */
export function isValidColormap(name: unknown): boolean {
  return (
    typeof name === "string" &&
    Object.prototype.hasOwnProperty.call(COLORMAP_FNS, name)
  );
}

/**
 * Applique une palette à une valeur normalisée t∈[0,1] et renvoie le triplet
 * RGB [0..255]. `t` est borné à [0,1] (les débordements et NaN sont gérés).
 * Une palette inconnue lève une `Error` (l'appelant doit valider via
 * `isValidColormap` ou passer un nom de `COLORMAPS`).
 */
export function applyColormap(name: string, normValue01: number): RGB {
  const fn = COLORMAP_FNS[name];
  if (!fn) throw new Error(`Palette inconnue : « ${name} »`);
  return fn(clamp01(normValue01));
}

/**
 * Construit la LUT 256×3 octets d'une palette : pour chaque index i∈[0,255], la
 * couleur de t = i/255. Renvoie un `Uint8ClampedArray` de longueur 768
 * (R,G,B entrelacés). Déterministe et indépendant de tout état.
 *
 * Palette inconnue → `Error`.
 */
export function getColormapLut(name: string): Uint8ClampedArray {
  const fn = COLORMAP_FNS[name];
  if (!fn) throw new Error(`Palette inconnue : « ${name} »`);
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = fn(i / (LUT_SIZE - 1));
    const o = i * 3;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
  }
  return lut;
}
