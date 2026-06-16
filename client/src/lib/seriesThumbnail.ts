// Logique pure pour les vignettes de série (testable, sans DOM/Cornerstone).
// La génération réelle de la vignette (rendu offscreen Cornerstone → data URL)
// vit dans `seriesThumbnailRenderer.ts`, qui dépend du navigateur.

/** Une instance minimale exploitable pour choisir une coupe représentative. */
export interface ThumbnailInstance {
  storageUrl?: string | null;
  instanceNumber?: number | null;
}

/**
 * Choisit l'index de la coupe représentative d'une série : la coupe « du milieu »
 * (souvent la plus parlante anatomiquement). Renvoie -1 si la liste est vide.
 *
 * Robuste aux entrées dégénérées (liste vide, longueur paire) : pour 1 coupe → 0,
 * pour N coupes → Math.floor(N/2).
 */
export function pickRepresentativeIndex(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return -1;
  return Math.floor(count / 2);
}

/**
 * Construit l'image id wadouri chargeable pour la coupe représentative d'une
 * série, à partir des instances. Réutilise EXACTEMENT le schéma du viewer
 * principal (`wadouri:<storageUrl>`). Renvoie null si aucune instance avec une
 * URL exploitable n'est disponible (série non chargeable → on garde le
 * placeholder noir).
 */
export function representativeImageId(
  instances: ReadonlyArray<ThumbnailInstance> | null | undefined
): string | null {
  if (!instances || instances.length === 0) return null;
  const idx = pickRepresentativeIndex(instances.length);
  if (idx < 0) return null;
  // La coupe du milieu peut ne pas avoir d'URL ; on retombe alors sur la
  // première instance disposant d'une storageUrl exploitable.
  const candidate = instances[idx]?.storageUrl;
  const url =
    (typeof candidate === "string" && candidate) ||
    instances.find(i => typeof i.storageUrl === "string" && i.storageUrl)
      ?.storageUrl;
  if (!url) return null;
  return `wadouri:${url}`;
}
