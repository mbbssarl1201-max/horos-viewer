// Tri des instances d'une série (menu « Sort By » du visualiseur).
//
// Horos propose de réordonner les coupes d'une série selon différents
// critères : numéro d'instance (InstanceNumber, 0020,0013) ou position
// anatomique (SliceLocation, 0020,1041). Ce module fournit des comparateurs
// PURS et un tri STABLE, sans dépendance Cornerstone / DOM / I/O — on ne
// manipule que des objets « instance » déjà parsés.
//
// Choix d'implémentation :
//   • Tri STABLE : on ne s'appuie pas sur la stabilité d'`Array.prototype.sort`
//     (garantie seulement depuis ES2019) — on décore chaque élément de son
//     index d'origine et on départage les égalités par cet index. L'ordre
//     d'entrée est ainsi préservé pour les valeurs égales OU absentes.
//   • Les instances dont la clé de tri est ABSENTE / non numérique sont
//     considérées comme « sans valeur » et repoussées EN FIN de liste (dans
//     leur ordre d'origine), quel que soit le sens asc/desc — on ne veut pas
//     qu'une coupe non datée s'intercale au milieu d'une pile triée.
//   • Fonction PURE : on renvoie un NOUVEAU tableau, l'entrée n'est jamais mutée.

/** Sous-ensemble des champs d'une instance utilisés pour le tri. */
export interface SortableInstance {
  /** Numéro d'instance DICOM (InstanceNumber, 0020,0013). */
  instanceNumber?: number | string | null;
  /** Position de coupe en mm (SliceLocation, 0020,1041). */
  sliceLocation?: number | string | null;
}

/** Un mode de tri exposé à l'UI (menu « Sort By »). */
export interface SortMode {
  /** Identifiant stable utilisé en interne. */
  id: string;
  /** Libellé affiché à l'utilisateur. */
  label: string;
}

/** Modes de tri disponibles dans le menu « Sort By ». */
export const SORT_MODES: readonly SortMode[] = [
  { id: "instanceNumber", label: "Numéro d'instance" },
  { id: "sliceLocation", label: "Position de coupe" },
] as const;

/** Convertit une valeur (number | string DICOM) en nombre fini, ou `null`. */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Tri stable et pur d'instances selon une clé numérique extraite par `key`.
 * Les valeurs absentes / non numériques sont repoussées en fin de liste, dans
 * leur ordre d'origine. `asc` contrôle le sens (par défaut croissant).
 */
function sortByNumericKey<T extends SortableInstance>(
  instances: readonly T[] | null | undefined,
  key: (it: T) => unknown,
  asc: boolean
): T[] {
  if (!instances || instances.length === 0) return [];
  // Décoration : (élément, index d'origine, valeur numérique ou null).
  const decorated = instances.map((it, index) => ({
    it,
    index,
    value: toFiniteNumber(key(it)),
  }));
  const dir = asc ? 1 : -1;
  decorated.sort((a, b) => {
    // Les éléments sans valeur vont toujours en fin (indépendant du sens).
    if (a.value === null && b.value === null) return a.index - b.index;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    if (a.value !== b.value) return (a.value - b.value) * dir;
    // Égalité de valeur → on préserve l'ordre d'entrée (stabilité).
    return a.index - b.index;
  });
  return decorated.map(d => d.it);
}

/**
 * Trie les instances par numéro d'instance (InstanceNumber). Stable, pur.
 * `asc = true` (défaut) → ordre croissant.
 */
export function sortByInstanceNumber<T extends SortableInstance>(
  instances: readonly T[] | null | undefined,
  asc = true
): T[] {
  return sortByNumericKey(instances, it => it.instanceNumber, asc);
}

/**
 * Trie les instances par position de coupe (SliceLocation). Stable, pur.
 * `asc = true` (défaut) → ordre croissant.
 */
export function sortBySliceLocation<T extends SortableInstance>(
  instances: readonly T[] | null | undefined,
  asc = true
): T[] {
  return sortByNumericKey(instances, it => it.sliceLocation, asc);
}
