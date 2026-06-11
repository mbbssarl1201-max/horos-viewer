/**
 * Indexation 4D (« 4D Viewer ») : série DICOM contenant plusieurs PHASES
 * temporelles d'un même volume — typiquement une perfusion, une IRM cardiaque
 * ciné, ou un examen dynamique (gated PET/CT). Chaque instance porte :
 *   • une POSITION spatiale (sliceLocation, mm le long de l'axe d'empilement),
 *   • un INDEX temporel (timeIndex : numéro de phase / temps cardiaque).
 *
 * Le but du module est de transformer une liste plate d'instances en une grille
 * (temps × coupe) interrogeable, pour qu'un viewer puisse balayer dans deux
 * dimensions : naviguer dans les coupes à temps fixe, OU dérouler le temps à
 * coupe fixe (ciné 4D).
 *
 * Fonctions PURES et déterministes : aucune dépendance Cornerstone / DOM / I/O.
 * On ne manipule que des nombres et la structure de la liste d'entrée.
 *
 * ── Modèle de données ────────────────────────────────────────────────────────
 * On suppose une grille RÉGULIÈRE : pour être un vrai volume 4D, chaque temps
 * doit présenter le MÊME ensemble de positions de coupe (même nombre de coupes,
 * mêmes sliceLocation). C'est la condition que vérifie `detect4d`.
 *
 * `build4dIndex` construit toujours une grille (même partielle) à partir des
 * temps et coupes DISTINCTS observés, ordonnés croissants. `frameAt(time, slice)`
 * rend l'indice (dans la liste d'entrée d'origine) de l'instance située à ce
 * couple (temps, coupe), ou `-1` si la cellule est vide. Les indices `time` et
 * `slice` passés à `frameAt` sont des indices de GRILLE (0-based), pas les
 * valeurs brutes.
 */

/** Instance minimale nécessaire à l'indexation 4D. */
export interface TemporalInstance {
  /** Position de la coupe le long de l'axe d'empilement (mm). */
  sliceLocation: number;
  /** Index temporel / numéro de phase (entier ou réel, croissant = plus tard). */
  timeIndex: number;
}

/** Grille 4D interrogeable construite par `build4dIndex`. */
export interface Temporal4dIndex {
  /** Valeurs de `timeIndex` DISTINCTES observées, triées croissantes. */
  times: number[];
  /** Valeurs de `sliceLocation` DISTINCTES observées, triées croissantes. */
  sliceLocations: number[];
  /** Nombre de coupes par temps (= `sliceLocations.length`). */
  slicesPerTime: number;
  /** Nombre de phases temporelles (= `times.length`). */
  timeCount: number;
  /**
   * Indice (dans la liste d'entrée d'origine) de l'instance au couple
   * (indice de temps, indice de coupe) de GRILLE. `-1` si la cellule est vide
   * ou si les indices sont hors bornes. En cas de doublon (plusieurs instances
   * au même couple), conserve la PREMIÈRE rencontrée.
   */
  frameAt(timeGridIndex: number, sliceGridIndex: number): number;
}

/** Petit epsilon pour regrouper des sliceLocation/timeIndex quasi identiques. */
const EPS = 1e-4;

/**
 * Renvoie les valeurs distinctes triées croissantes d'une liste de nombres
 * finis, en fusionnant celles séparées de moins de `eps` (tolérance flottante).
 * Les valeurs non finies (NaN, ±Infinity) sont ignorées.
 */
function distinctSorted(values: readonly number[], eps = EPS): number[] {
  const finite = values.filter(v => Number.isFinite(v));
  const sorted = [...finite].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last === undefined || Math.abs(v - last) > eps) {
      out.push(v);
    }
  }
  return out;
}

/**
 * Trouve l'indice de la valeur de grille la plus proche de `value` dans `axis`
 * (trié croissant), si elle est à moins de `eps`. Renvoie `-1` sinon. Recherche
 * linéaire (axes 4D petits : qq dizaines de coupes / temps au plus).
 */
function gridIndexOf(
  axis: readonly number[],
  value: number,
  eps = EPS
): number {
  if (!Number.isFinite(value)) return -1;
  let best = -1;
  let bestDist = eps;
  for (let i = 0; i < axis.length; i += 1) {
    const d = Math.abs(axis[i] - value);
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Construit la grille 4D (temps × coupe) à partir d'une liste plate d'instances.
 *
 * • Les axes `times` / `sliceLocations` sont les valeurs DISTINCTES triées.
 * • La table interne mappe chaque couple (temps, coupe) → indice d'origine.
 * • `frameAt` est borné et renvoie `-1` pour toute cellule vide ou hors grille.
 *
 * PUR : ne lit que `instances`, ne mute pas l'entrée. Liste vide → grille vide
 * (`frameAt` renvoie toujours `-1`). Les instances dont `sliceLocation` ou
 * `timeIndex` n'est pas fini sont ignorées (ni dans les axes, ni indexées).
 */
export function build4dIndex(
  instances: readonly TemporalInstance[]
): Temporal4dIndex {
  const times = distinctSorted(instances.map(i => i.timeIndex));
  const sliceLocations = distinctSorted(instances.map(i => i.sliceLocation));

  // Table dense temps×coupe → indice d'origine (-1 = vide). On garde la
  // PREMIÈRE instance rencontrée pour un couple donné (déterministe).
  const cols = sliceLocations.length;
  const cell: number[] = new Array(times.length * cols).fill(-1);
  for (let idx = 0; idx < instances.length; idx += 1) {
    const inst = instances[idx];
    const t = gridIndexOf(times, inst.timeIndex);
    const s = gridIndexOf(sliceLocations, inst.sliceLocation);
    if (t < 0 || s < 0) continue; // valeur non finie → ignorée
    const flat = t * cols + s;
    if (cell[flat] === -1) cell[flat] = idx;
  }

  const frameAt = (timeGridIndex: number, sliceGridIndex: number): number => {
    if (
      !Number.isInteger(timeGridIndex) ||
      !Number.isInteger(sliceGridIndex) ||
      timeGridIndex < 0 ||
      timeGridIndex >= times.length ||
      sliceGridIndex < 0 ||
      sliceGridIndex >= cols
    ) {
      return -1;
    }
    return cell[timeGridIndex * cols + sliceGridIndex];
  };

  return {
    times,
    sliceLocations,
    slicesPerTime: cols,
    timeCount: times.length,
    frameAt,
  };
}

/**
 * Vrai si la liste constitue un vrai volume 4D : au moins 2 phases temporelles
 * ET au moins 2 coupes par phase ET une grille COMPLÈTE & RÉGULIÈRE — chaque
 * couple (temps, coupe) occupé exactement une fois (aucune cellule vide, aucun
 * doublon). Une série purement spatiale (1 seul temps) ou purement temporelle
 * (1 seule coupe) n'est PAS « 4D ». Toute instance non finie disqualifie la
 * détection (donnée corrompue).
 */
export function detect4d(instances: readonly TemporalInstance[]): boolean {
  if (instances.length < 4) return false; // 2 temps × 2 coupes minimum
  // Rejet si une coordonnée n'est pas finie.
  for (const i of instances) {
    if (!Number.isFinite(i.sliceLocation) || !Number.isFinite(i.timeIndex)) {
      return false;
    }
  }
  const idx = build4dIndex(instances);
  if (idx.timeCount < 2 || idx.slicesPerTime < 2) return false;

  const expected = idx.timeCount * idx.slicesPerTime;
  // Grille complète <=> autant de cellules occupées que de cellules,
  // ET autant d'instances que de cellules (pas de doublon).
  if (instances.length !== expected) return false;
  for (let t = 0; t < idx.timeCount; t += 1) {
    for (let s = 0; s < idx.slicesPerTime; s += 1) {
      if (idx.frameAt(t, s) < 0) return false;
    }
  }
  return true;
}
