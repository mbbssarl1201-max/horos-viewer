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
 * Convertit points + cellules VTK en chaîne OBJ.
 * Les indices OBJ sont 1-BASÉS (le premier sommet est `1`).
 *
 * @param points Coordonnées aplaties [x0,y0,z0, x1,y1,z1, …] (mm, monde).
 * @param polys  Tableau de cellules VTK [n, id0, …, id(n-1), n, …].
 */
export function polyDataArraysToObj(
  points: Float32Array | number[],
  polys: Int32Array | number[]
): string {
  const lines: string[] = [];

  // Sommets : un `v x y z` par point (3 composantes consécutives).
  const vertexCount = Math.floor(points.length / 3);
  for (let i = 0; i < vertexCount; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    lines.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
  }

  // Faces : on parcourt les blocs [n, id…] et on triangule en éventail.
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
      lines.push(`f ${ids[0] + 1} ${ids[k] + 1} ${ids[k + 1] + 1}`);
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
