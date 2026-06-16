/**
 * Sérialisation d'un maillage (polydata VTK.js) au format PLY BINAIRE
 * (`binary_little_endian`) — bien plus compact que l'OBJ texte : positions et
 * normales en float32 (4 octets) et couleurs en uchar (1 octet), au lieu de
 * chaînes décimales. Pour un maillage colorié + normales, on attend ~3 à 5×
 * plus petit que l'OBJ équivalent.
 *
 * Fonction PURE (hors construction du Blob) : on ne manipule que les tableaux
 * bruts du polydata. Même convention que objExport.ts pour le tableau de
 * cellules VTK (`polys`) : suite de blocs [n, id0, …, id(n-1)]. On TRIANGULE en
 * éventail toute cellule n ≥ 3 ; les cellules n < 3 (dégénérées) sont ignorées.
 *
 * En-tête généré (exemple avec normales + couleurs) :
 *   ply
 *   format binary_little_endian 1.0
 *   element vertex N
 *   property float x / y / z
 *   property float nx / ny / nz        (si normales)
 *   property uchar red / green / blue  (si couleurs)
 *   element face M
 *   property list uchar int vertex_indices
 *   end_header
 *   <corps binaire>
 */

export interface PlyMeshInput {
  /** Coordonnées aplaties [x0,y0,z0, …] (mm, monde). */
  points: Float32Array | number[];
  /** Tableau de cellules VTK [n, id0, …, id(n-1), n, …]. */
  polys: Int32Array | number[];
  /** Couleurs par sommet aplaties [r,g,b, …] en 0..1 (→ uchar 0..255). */
  colors?: Float32Array | number[];
  /** Normales par sommet aplaties [nx,ny,nz, …]. */
  normals?: Float32Array | number[];
}

/**
 * Construit le maillage binaire PLY et le renvoie sous forme de `Blob`
 * (type `application/octet-stream`). Couleurs/normales validées : on ne les
 * inclut que si leur longueur vaut exactement 3 × (nombre de sommets), sinon
 * repli silencieux (comme polyDataArraysToObj).
 */
export function meshToBinaryPly(input: PlyMeshInput): Blob {
  const { points, polys } = input;
  const vertexCount = Math.floor(points.length / 3);

  const colors =
    input.colors && input.colors.length === vertexCount * 3
      ? input.colors
      : undefined;
  const normals =
    input.normals && input.normals.length === vertexCount * 3
      ? input.normals
      : undefined;

  // 1. Triangulation en éventail → liste plate de triplets d'indices.
  const triangles: number[] = [];
  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    if (n >= 3) {
      const i0 = polys[i + 1];
      for (let k = 1; k < n - 1; k++) {
        triangles.push(i0, polys[i + 1 + k], polys[i + 1 + k + 1]);
      }
    }
    i += 1 + n;
  }
  const faceCount = triangles.length / 3;

  // 2. En-tête ASCII (les en-têtes PLY restent toujours en texte).
  const headerLines = ["ply", "format binary_little_endian 1.0"];
  headerLines.push(`element vertex ${vertexCount}`);
  headerLines.push("property float x", "property float y", "property float z");
  if (normals)
    headerLines.push(
      "property float nx",
      "property float ny",
      "property float nz"
    );
  if (colors)
    headerLines.push(
      "property uchar red",
      "property uchar green",
      "property uchar blue"
    );
  headerLines.push(`element face ${faceCount}`);
  headerLines.push("property list uchar int vertex_indices");
  headerLines.push("end_header", "");
  const headerBytes = new TextEncoder().encode(headerLines.join("\n"));

  // 3. Taille du corps binaire.
  // Par sommet : 3 float (x,y,z) + 3 float optionnels (normales) + 3 uchar opt.
  const floatsPerVertex = 3 + (normals ? 3 : 0);
  const ucharPerVertex = colors ? 3 : 0;
  const vertexBytes = vertexCount * (floatsPerVertex * 4 + ucharPerVertex);
  // Par face : 1 uchar (compte = 3) + 3 int32 (indices).
  const faceBytes = faceCount * (1 + 3 * 4);

  const buffer = new ArrayBuffer(
    headerBytes.byteLength + vertexBytes + faceBytes
  );
  const u8 = new Uint8Array(buffer);
  u8.set(headerBytes, 0);

  const dv = new DataView(buffer);
  const LE = true;
  let off = headerBytes.byteLength;

  const toUchar = (v: number) => {
    const c = Math.round((v ?? 0) * 255);
    return c < 0 ? 0 : c > 255 ? 255 : c;
  };

  // 4. Sommets.
  for (let v = 0; v < vertexCount; v++) {
    dv.setFloat32(off, points[v * 3] ?? 0, LE);
    off += 4;
    dv.setFloat32(off, points[v * 3 + 1] ?? 0, LE);
    off += 4;
    dv.setFloat32(off, points[v * 3 + 2] ?? 0, LE);
    off += 4;
    if (normals) {
      dv.setFloat32(off, normals[v * 3] ?? 0, LE);
      off += 4;
      dv.setFloat32(off, normals[v * 3 + 1] ?? 0, LE);
      off += 4;
      dv.setFloat32(off, normals[v * 3 + 2] ?? 0, LE);
      off += 4;
    }
    if (colors) {
      dv.setUint8(off, toUchar(colors[v * 3]));
      off += 1;
      dv.setUint8(off, toUchar(colors[v * 3 + 1]));
      off += 1;
      dv.setUint8(off, toUchar(colors[v * 3 + 2]));
      off += 1;
    }
  }

  // 5. Faces : uchar(3) puis 3 int32 (indices 0-basés, comme PLY l'exige).
  for (let t = 0; t < faceCount; t++) {
    dv.setUint8(off, 3);
    off += 1;
    dv.setInt32(off, triangles[t * 3], LE);
    off += 4;
    dv.setInt32(off, triangles[t * 3 + 1], LE);
    off += 4;
    dv.setInt32(off, triangles[t * 3 + 2], LE);
    off += 4;
  }

  return new Blob([buffer], { type: "application/octet-stream" });
}
