/**
 * Sérialisation d'un maillage (polydata VTK.js) au format Wavefront .OBJ.
 *
 * Fonctions PURES et testables : aucune dépendance à VTK ni au DOM, on ne
 * manipule que les tableaux bruts extraits du polydata
 * (`getPoints().getData()` et `getPolys().getData()`).
 *
 * Format VTK du tableau de cellules (`polys`) : suite de blocs
 *   [n, id0, id1, …, id(n-1)]  répétée pour chaque cellule,
 * où `n` est le nombre de sommets de la cellule. Pour `vtkImageMarchingCubes`,
 * toutes les cellules sont des triangles (n = 3).
 *
 * Gestion des cellules non-triangulaires : on TRIANGULE en éventail (fan)
 * toute cellule de n ≥ 3 sommets → triangles (id0,id1,id2), (id0,id2,id3)…
 * Les cellules dégénérées (n < 3) sont IGNORÉES (rien à dessiner). Cela rend la
 * sortie robuste si une version renvoyait des quads/polygones plutôt que des
 * triangles, sans jamais produire d'OBJ invalide.
 */

export interface ObjMeshStats {
  /** Nombre de sommets écrits (lignes `v`). */
  vertexCount: number;
  /** Nombre de triangles écrits (lignes `f`). */
  triangleCount: number;
}

/**
 * Convertit un point monde (mm) en coordonnées d'index (fractionnaires) dans la
 * grille de voxels. HYPOTHÈSE : direction axis-aligned / identité (les axes du
 * volume sont alignés sur x/y/z monde). Pour un volume oblique (matrice de
 * direction non identité), il faudrait appliquer l'inverse de la matrice de
 * direction — non géré ici (cf. note dans handleExportObj). On reste robuste :
 * spacing nul → on évite la division par zéro (renvoie l'index 0 sur cet axe).
 */
export function worldToIndex(
  point: readonly [number, number, number] | ArrayLike<number>,
  origin: readonly [number, number, number] | ArrayLike<number>,
  spacing: readonly [number, number, number] | ArrayLike<number>
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const sp = spacing[a];
    out[a] = sp ? (point[a] - origin[a]) / sp : 0;
  }
  return out;
}

/**
 * Échantillonne le tableau scalaire (HU) par interpolation TRILINÉAIRE à la
 * position d'index fractionnaire (ix, iy, iz). `dims = [nx, ny, nz]`, l'ordre
 * mémoire est celui de VTK / Cornerstone : index = x + y*nx + z*nx*ny.
 *
 * Les coordonnées hors-grille sont CLAMPÉES sur les bords (pas d'accès hors
 * borne). Aux positions de voxel exactes, renvoie la valeur du voxel ; aux
 * milieux, la moyenne des 8 (resp. 2/4) voisins.
 */
export function sampleVolumeTrilinear(
  scalars: ArrayLike<number>,
  dims: readonly [number, number, number] | ArrayLike<number>,
  ix: number,
  iy: number,
  iz: number
): number {
  const nx = dims[0] | 0;
  const ny = dims[1] | 0;
  const nz = dims[2] | 0;
  if (nx <= 0 || ny <= 0 || nz <= 0) return 0;

  const clamp = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);

  const fx = clamp(ix, nx - 1);
  const fy = clamp(iy, ny - 1);
  const fz = clamp(iz, nz - 1);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);

  const dx = fx - x0;
  const dy = fy - y0;
  const dz = fz - z0;

  const at = (x: number, y: number, z: number) =>
    scalars[x + y * nx + z * nx * ny] ?? 0;

  // Interpolation sur x puis y puis z.
  const c000 = at(x0, y0, z0);
  const c100 = at(x1, y0, z0);
  const c010 = at(x0, y1, z0);
  const c110 = at(x1, y1, z0);
  const c001 = at(x0, y0, z1);
  const c101 = at(x1, y0, z1);
  const c011 = at(x0, y1, z1);
  const c111 = at(x1, y1, z1);

  const c00 = c000 * (1 - dx) + c100 * dx;
  const c10 = c010 * (1 - dx) + c110 * dx;
  const c01 = c001 * (1 - dx) + c101 * dx;
  const c11 = c011 * (1 - dx) + c111 * dx;

  const c0 = c00 * (1 - dy) + c10 * dy;
  const c1 = c01 * (1 - dy) + c11 * dy;

  return c0 * (1 - dz) + c1 * dz;
}

/**
 * Mappe une valeur HU vers un niveau de gris RGB (0..1) via une fenêtre
 * largeur/centre (WW/WC), comme l'affichage 2D. HU au-dessous de wc-ww/2 → noir,
 * au-dessus de wc+ww/2 → blanc, linéaire entre les deux. WW ≤ 0 → repli sur 1
 * (évite la division par zéro, rend un seuil dur). Renvoie `[r, g, b]` égaux
 * (gris) — le même canal est dupliqué.
 */
export function huToRgb(
  hu: number,
  wc: number,
  ww: number
): [number, number, number] {
  const width = ww > 0 ? ww : 1;
  const low = wc - width / 2;
  let g = (hu - low) / width;
  if (g < 0) g = 0;
  else if (g > 1) g = 1;
  return [g, g, g];
}

/**
 * Convertit points + cellules VTK en chaîne OBJ.
 * Les indices OBJ sont 1-BASÉS (le premier sommet est `1`).
 *
 * Options (toutes facultatives, rétro-compatibles) :
 *   • `colors`  : couleurs par sommet aplaties [r0,g0,b0, r1,g1,b1, …] en 0..1.
 *                 Émises en `v x y z r g b` (extension OBJ supportée par MeshLab,
 *                 Blender…). Longueur attendue = 3 × nb de sommets ; sinon ignorées.
 *   • `normals` : normales par sommet aplaties [nx,ny,nz, …]. Émises en `vn …`,
 *                 et les faces deviennent `f v//vn` (même index sommet/normale).
 *
 * @param points Coordonnées aplaties [x0,y0,z0, x1,y1,z1, …] (mm, monde).
 * @param polys  Tableau de cellules VTK [n, id0, …, id(n-1), n, …].
 */
export function polyDataArraysToObj(
  points: Float32Array | number[],
  polys: Int32Array | number[],
  opts?: {
    colors?: Float32Array | number[];
    normals?: Float32Array | number[];
  }
): string {
  const lines: string[] = [];

  const vertexCount = Math.floor(points.length / 3);
  // Couleurs / normales validées : on n'écrit l'extension que si la longueur
  // correspond exactement (3 composantes par sommet), sinon repli silencieux.
  const colors =
    opts?.colors && opts.colors.length === vertexCount * 3
      ? opts.colors
      : undefined;
  const normals =
    opts?.normals && opts.normals.length === vertexCount * 3
      ? opts.normals
      : undefined;

  // Sommets : `v x y z` ou `v x y z r g b` si couleurs fournies.
  for (let i = 0; i < vertexCount; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    if (colors) {
      const r = colors[i * 3];
      const g = colors[i * 3 + 1];
      const b = colors[i * 3 + 2];
      lines.push(
        `v ${fmt(x)} ${fmt(y)} ${fmt(z)} ${fmt(r)} ${fmt(g)} ${fmt(b)}`
      );
    } else {
      lines.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
    }
  }

  // Normales : un `vn nx ny nz` par sommet (même indexation que les `v`).
  if (normals) {
    for (let i = 0; i < vertexCount; i++) {
      lines.push(
        `vn ${fmt(normals[i * 3])} ${fmt(normals[i * 3 + 1])} ${fmt(
          normals[i * 3 + 2]
        )}`
      );
    }
  }

  // Faces : on parcourt les blocs [n, id…] et on triangule en éventail.
  // Avec normales : `f a//a b//b c//c` (index normale = index sommet, 1-basé).
  const face = (a: number, b: number, c: number) =>
    normals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`;
  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    // Garde-fou : compteur incohérent (négatif, NaN) ou bloc tronqué → stop.
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    const ids = polys.slice(i + 1, i + 1 + n);
    i += 1 + n;
    if (n < 3) continue; // cellule dégénérée (point/segment) : rien à exporter.
    // Éventail : (ids[0], ids[k], ids[k+1]). OBJ = indices 1-basés.
    for (let k = 1; k < n - 1; k++) {
      lines.push(face(ids[0] + 1, ids[k] + 1, ids[k + 1] + 1));
    }
  }

  return lines.join("\n") + "\n";
}

/** Statistiques (sommets/triangles) sans matérialiser la chaîne OBJ entière. */
export function polyDataArraysStats(
  points: Float32Array | number[],
  polys: Int32Array | number[]
): ObjMeshStats {
  const vertexCount = Math.floor(points.length / 3);
  let triangleCount = 0;
  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    if (n >= 3) triangleCount += n - 2; // triangles produits par l'éventail.
    i += 1 + n;
  }
  return { vertexCount, triangleCount };
}

/** Format compact d'un flottant : entiers sans décimale, sinon 6 chiffres max. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  // Coupe la précision excessive du Float32 tout en gardant l'échelle mm.
  return parseFloat(v.toFixed(6)).toString();
}
