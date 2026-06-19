/**
 * Logique PURE de la fonction de transfert d'opacité (« fenêtrage 3D ») : modèle
 * de points {value: HU, opacity: 0..1}, normalisation, et (dé)sérialisation des
 * presets perso pour localStorage. Sans DOM ni VTK → testable.
 */

export interface OpacityPoint {
  /** Valeur scalaire (HU pour un CT). */
  value: number;
  /** Opacité [0..1]. */
  opacity: number;
}

export interface TfPreset {
  name: string;
  points: OpacityPoint[];
}

/** Borne l'opacité dans [0,1] ; entrée non finie → 0. */
export function clampOpacity(o: number): number {
  if (!Number.isFinite(o)) return 0;
  return Math.min(1, Math.max(0, o));
}

/** Trie par `value` croissante, borne l'opacité, retire les `value` non finies. */
export function normalizeOpacityPoints(
  points: readonly OpacityPoint[]
): OpacityPoint[] {
  return points
    .filter(p => Number.isFinite(p.value))
    .map(p => ({ value: p.value, opacity: clampOpacity(p.opacity) }))
    .sort((a, b) => a.value - b.value);
}

/** Rampe d'opacité linéaire 0→1 entre `loHU` et `hiHU` (2 points). */
export function defaultOpacityRamp(loHU: number, hiHU: number): OpacityPoint[] {
  return [
    { value: loHU, opacity: 0 },
    { value: hiHU, opacity: 1 },
  ];
}

export interface ColorPoint {
  /** Valeur scalaire (HU pour un CT). */
  value: number;
  /** Composantes [0..1]. */
  r: number;
  g: number;
  b: number;
}

/** "#rrggbb" → {r,g,b} ∈ [0..1] ; entrée invalide → noir. PUR. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

/** {r,g,b}∈[0..1] → "#rrggbb". PUR. */
export function rgb01ToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Trie par value, clampe rgb [0..1], retire les value non finies. PUR. */
export function normalizeColorPoints(
  points: readonly ColorPoint[]
): ColorPoint[] {
  return points
    .filter(p => Number.isFinite(p.value))
    .map(p => ({
      value: p.value,
      r: clamp01(p.r),
      g: clamp01(p.g),
      b: clamp01(p.b),
    }))
    .sort((a, b) => a.value - b.value);
}

/** Rampe couleur par défaut : noir (lo) → blanc (hi). PUR. */
export function defaultColorPoints(loHU: number, hiHU: number): ColorPoint[] {
  return [
    { value: loHU, r: 0, g: 0, b: 0 },
    { value: hiHU, r: 1, g: 1, b: 1 },
  ];
}

export function serializePresets(presets: readonly TfPreset[]): string {
  return JSON.stringify(presets);
}

/** Parse des presets depuis localStorage ; toute entrée invalide → []. */
export function deserializePresets(json: string | null): TfPreset[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (p: any) => p && typeof p.name === "string" && Array.isArray(p.points)
      )
      .map((p: any) => ({
        name: p.name,
        points: normalizeOpacityPoints(p.points),
      }));
  } catch {
    return [];
  }
}
