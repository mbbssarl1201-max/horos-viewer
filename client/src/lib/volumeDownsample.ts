/**
 * Sous-échantillonnage (downsampling) d'un volume scalaire pour alléger
 * l'extraction de maillage 3D.
 *
 * vtk.js 34.x N'A PAS de filtre de décimation de maillage : on réduit donc la
 * taille du maillage exporté EN AMONT, en réduisant la résolution du volume
 * passé aux marching cubes. Avec un facteur `f`, on ne garde qu'un voxel sur
 * `f` le long de chaque axe (échantillonnage par pas / stride), ce qui divise
 * le nombre de voxels par ~f³ (f=2 → ~1/8, f=4 → ~1/64) et donc fortement le
 * nombre de triangles.
 *
 * Fonction PURE : aucune dépendance VTK/DOM. L'ordre mémoire est celui de
 * VTK / Cornerstone : index = x + y*nx + z*nx*ny.
 *
 * Ajustements géométriques pour rester aligné dans le monde :
 *   • dims    → ceil(dim / f) sur chaque axe (on prend les indices 0, f, 2f, …).
 *   • spacing → spacing * f (chaque voxel couvre f fois plus de mm).
 *   • origin  → inchangé (le premier voxel conservé est l'indice 0).
 */
export interface DownsampledVolume {
  scalars: Float32Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
}

export function downsampleScalarVolume(
  scalars: ArrayLike<number>,
  dims: readonly [number, number, number] | ArrayLike<number>,
  spacing: readonly [number, number, number] | ArrayLike<number>,
  origin: readonly [number, number, number] | ArrayLike<number>,
  factor: number
): DownsampledVolume {
  const nx = dims[0] | 0;
  const ny = dims[1] | 0;
  const nz = dims[2] | 0;
  // Facteur entier ≥ 1 ; f=1 → copie fidèle (aucune réduction).
  const f = Number.isFinite(factor) && factor >= 1 ? Math.floor(factor) : 1;

  const outNx = Math.max(1, Math.ceil(nx / f));
  const outNy = Math.max(1, Math.ceil(ny / f));
  const outNz = Math.max(1, Math.ceil(nz / f));

  const out = new Float32Array(outNx * outNy * outNz);

  // Stride sampling : on prend les voxels d'indices 0, f, 2f, … sur chaque axe.
  for (let oz = 0; oz < outNz; oz++) {
    const sz = Math.min(oz * f, nz - 1);
    for (let oy = 0; oy < outNy; oy++) {
      const sy = Math.min(oy * f, ny - 1);
      const srcRow = sy * nx + sz * nx * ny;
      const dstRow = oy * outNx + oz * outNx * outNy;
      for (let ox = 0; ox < outNx; ox++) {
        const sx = Math.min(ox * f, nx - 1);
        out[dstRow + ox] = scalars[srcRow + sx] ?? 0;
      }
    }
  }

  return {
    scalars: out,
    dims: [outNx, outNy, outNz],
    spacing: [spacing[0] * f, spacing[1] * f, spacing[2] * f],
    origin: [origin[0], origin[1], origin[2]],
  };
}
