/**
 * Lissage de maillage (Taubin λ|μ) + utilitaires de topologie/normales.
 *
 * Le maillage issu de `vtkImageMarchingCubes` présente l'aliasing « en
 * escalier » typique des isosurfaces sur grille de voxels. Le lissage de Taubin
 * atténue ces marches SANS rétrécir le volume (contrairement à un simple
 * lissage Laplacien) : il alterne une passe Laplacienne d'expansion (+λ) et une
 * passe de contraction (μ < 0) qui compense le rétrécissement.
 *
 * Fonctions PURES : aucune dépendance VTK/DOM, on ne manipule que les tableaux
 * bruts du polydata. Même convention que objExport/plyExport pour le tableau de
 * cellules VTK (`polys`) : suite de blocs [n, id0, …, id(n-1)]. On triangule en
 * éventail (fan) les cellules n > 3 et on ignore les cellules dégénérées n < 3.
 */

/**
 * Construit l'adjacence sommet→voisins à partir du tableau de cellules VTK.
 * Renvoie, pour chaque sommet [0..vertexCount[, l'ensemble (Set) des indices de
 * sommets voisins (reliés par une arête de triangle). Les arêtes sont
 * symétriques (i↔j ajoutés des deux côtés). Indices hors borne ignorés.
 */
export function buildVertexAdjacency(
  polys: Int32Array | number[],
  vertexCount: number
): Set<number>[] {
  const adjacency: Set<number>[] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) adjacency[v] = new Set<number>();

  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    if (a < 0 || a >= vertexCount || b < 0 || b >= vertexCount) return;
    adjacency[a].add(b);
    adjacency[b].add(a);
  };

  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    if (n >= 3) {
      const i0 = polys[i + 1];
      // Triangulation en éventail : (i0, ik, ik+1) → arêtes du triangle.
      for (let k = 1; k < n - 1; k++) {
        const ia = polys[i + 1 + k];
        const ib = polys[i + 1 + k + 1];
        addEdge(i0, ia);
        addEdge(ia, ib);
        addEdge(ib, i0);
      }
    }
    i += 1 + n;
  }
  return adjacency;
}

export interface TaubinOptions {
  /** Nombre d'itérations (chaque itération = 1 passe +λ puis 1 passe μ). */
  iterations?: number;
  /** Facteur d'expansion Laplacienne (0 < λ < 1). */
  lambda?: number;
  /** Facteur de contraction (μ < -λ pour compenser le rétrécissement). */
  mu?: number;
}

/**
 * Lissage de Taubin λ|μ. Pour chaque passe avec un facteur `c` (λ ou μ), chaque
 * sommet est déplacé vers la moyenne de ses voisins :
 *   p ← p + c · (moyenne(voisins) − p)
 * Une itération applique d'abord +λ (expansion) puis μ (contraction), ce qui
 * conserve approximativement le volume. Les sommets sans voisin restent fixes.
 *
 * @returns un NOUVEAU Float32Array (l'entrée n'est pas modifiée).
 */
export function taubinSmooth(
  points: Float32Array | number[],
  adjacency: Set<number>[],
  opts?: TaubinOptions
): Float32Array {
  const iterations = opts?.iterations ?? 10;
  const lambda = opts?.lambda ?? 0.5;
  const mu = opts?.mu ?? -0.53;

  const vertexCount = Math.floor(points.length / 3);
  let cur = Float32Array.from(points);
  // Tampon de travail réutilisé entre les passes (évite des allocations).
  let next = new Float32Array(cur.length);

  // Une passe Laplacienne : next = cur + factor·(moyenne(voisins) − cur).
  const pass = (factor: number) => {
    for (let v = 0; v < vertexCount; v++) {
      const neigh = adjacency[v];
      const base = v * 3;
      if (!neigh || neigh.size === 0) {
        // Sommet isolé : inchangé.
        next[base] = cur[base];
        next[base + 1] = cur[base + 1];
        next[base + 2] = cur[base + 2];
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      neigh.forEach(j => {
        sx += cur[j * 3];
        sy += cur[j * 3 + 1];
        sz += cur[j * 3 + 2];
      });
      const inv = 1 / neigh.size;
      const cx = cur[base];
      const cy = cur[base + 1];
      const cz = cur[base + 2];
      next[base] = cx + factor * (sx * inv - cx);
      next[base + 1] = cy + factor * (sy * inv - cy);
      next[base + 2] = cz + factor * (sz * inv - cz);
    }
    // Échange des tampons (next devient courant).
    const tmp = cur;
    cur = next;
    next = tmp;
  };

  for (let it = 0; it < iterations; it++) {
    pass(lambda);
    pass(mu);
  }
  return cur;
}

/**
 * Recalcule des normales par sommet (pondérées par l'aire des faces) à partir
 * des positions + cellules VTK. Indispensable APRÈS lissage : le déplacement des
 * sommets invalide les normales calculées par les marching cubes.
 *
 * Méthode : pour chaque triangle, on accumule le produit vectoriel (E1 × E2) —
 * dont la norme vaut 2× l'aire — sur ses trois sommets, puis on normalise par
 * sommet. La pondération par l'aire est donc implicite (les grandes faces pèsent
 * plus). Sommets sans contribution → normale nulle.
 *
 * @returns un Float32Array [nx0,ny0,nz0, …] de longueur 3 × nombre de sommets.
 */
export function computeVertexNormals(
  points: Float32Array | number[],
  polys: Int32Array | number[]
): Float32Array {
  const vertexCount = Math.floor(points.length / 3);
  const normals = new Float32Array(vertexCount * 3);

  const accumulate = (a: number, b: number, c: number) => {
    if (
      a < 0 ||
      a >= vertexCount ||
      b < 0 ||
      b >= vertexCount ||
      c < 0 ||
      c >= vertexCount
    )
      return;
    const ax = points[a * 3];
    const ay = points[a * 3 + 1];
    const az = points[a * 3 + 2];
    const bx = points[b * 3];
    const by = points[b * 3 + 1];
    const bz = points[b * 3 + 2];
    const cx = points[c * 3];
    const cy = points[c * 3 + 1];
    const cz = points[c * 3 + 2];
    // Arêtes E1 = B−A, E2 = C−A.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    // N = E1 × E2 (norme = 2·aire → pondération par l'aire implicite).
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
  };

  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    if (n >= 3) {
      const i0 = polys[i + 1];
      for (let k = 1; k < n - 1; k++) {
        accumulate(i0, polys[i + 1 + k], polys[i + 1 + k + 1]);
      }
    }
    i += 1 + n;
  }

  // Normalisation par sommet.
  for (let v = 0; v < vertexCount; v++) {
    const base = v * 3;
    const nx = normals[base];
    const ny = normals[base + 1];
    const nz = normals[base + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      normals[base] = nx / len;
      normals[base + 1] = ny / len;
      normals[base + 2] = nz / len;
    }
  }
  return normals;
}
