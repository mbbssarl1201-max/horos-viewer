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
