// Gestion des « images clés » (Key Images) façon Horos.
//
// Dans Horos, un radiologue peut marquer certaines coupes d'une série comme
// « images clés » (menu « Set Key Image »), puis naviguer rapidement entre
// elles (« Find Next/Previous Key Image »). On peut aussi tout marquer ou tout
// démarquer (« Set All / None as Key Images »).
//
// Ce module ne manipule QUE des données : un ensemble d'index de coupes
// marquées, représenté par un tableau d'entiers TRIÉ et SANS DOUBLON. Toutes
// les fonctions sont PURES et immuables : elles renvoient un NOUVEAU tableau
// (ou un index) sans jamais muter leur entrée. Aucune dépendance React / DOM /
// Cornerstone : entièrement testable hors navigateur.
//
// Conventions :
//   • un index de coupe est un entier ≥ 0 ;
//   • la liste des clés est toujours normalisée (triée croissante, unique) ;
//   • les entrées invalides (non entières, négatives, NaN) sont ignorées, sans
//     exception : on préfère une liste propre à une erreur en cours de séance.

/** Normalise une liste d'index : ne garde que les entiers ≥ 0, dédoublonne, trie. */
function normalizeKeys(keys: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const k of keys) {
    if (Number.isInteger(k) && k >= 0) seen.add(k);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Vrai si `index` est un entier ≥ 0 exploitable comme coupe. */
function isValidIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0;
}

/**
 * Bascule l'état « image clé » de la coupe `index` : si elle est déjà marquée
 * on la retire, sinon on l'ajoute. Renvoie une NOUVELLE liste normalisée
 * (triée, sans doublon). Un `index` invalide renvoie la liste normalisée
 * inchangée (pas d'exception).
 */
export function toggleKeyImage(
  keys: readonly number[],
  index: number
): number[] {
  const base = normalizeKeys(keys);
  if (!isValidIndex(index)) return base;
  return base.includes(index)
    ? base.filter(k => k !== index)
    : normalizeKeys([...base, index]);
}

/**
 * Renvoie l'index de la PROCHAINE image clé strictement après `current`. Le
 * parcours est CIRCULAIRE : s'il n'y a pas de clé après `current`, on repart à
 * la première (la plus petite). Si aucune clé n'existe, renvoie `current`
 * (rien où aller). `current` peut être quelconque (même non marqué).
 */
export function nextKeyImage(keys: readonly number[], current: number): number {
  const sorted = normalizeKeys(keys);
  if (sorted.length === 0) return current;
  const next = sorted.find(k => k > current);
  return next !== undefined ? next : sorted[0];
}

/**
 * Renvoie l'index de l'image clé PRÉCÉDENTE strictement avant `current`. Le
 * parcours est CIRCULAIRE : s'il n'y a pas de clé avant `current`, on repart à
 * la dernière (la plus grande). Si aucune clé n'existe, renvoie `current`.
 */
export function prevKeyImage(keys: readonly number[], current: number): number {
  const sorted = normalizeKeys(keys);
  if (sorted.length === 0) return current;
  // On cherche la plus grande clé strictement inférieure à `current`.
  let prev: number | undefined;
  for (const k of sorted) {
    if (k < current) prev = k;
    else break; // trié croissant → plus rien d'inférieur après
  }
  return prev !== undefined ? prev : sorted[sorted.length - 1];
}

/**
 * Marque TOUTES les coupes [0, count) comme images clés (« Set All »). Renvoie
 * une nouvelle liste 0,1,…,count-1. Un `count` ≤ 0 ou non entier renvoie une
 * liste vide.
 */
export function markAll(count: number): number[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => i);
}

/** Démarque toutes les coupes (« Set None ») : renvoie une liste vide. */
export function unmarkAll(): number[] {
  return [];
}
