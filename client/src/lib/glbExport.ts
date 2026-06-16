/**
 * Sérialisation d'un maillage en glTF 2.0 binaire (.glb) — conteneur unique
 * (header + chunk JSON + chunk BIN) directement importable dans Blender, les
 * navigateurs, three.js, etc. Plus interopérable que PLY/OBJ pour la 3D web.
 *
 * Tout est pur (hors construction du Blob) : on ne dépend ni de VTK ni du DOM.
 * Un seul buffer contient toutes les données ; un bufferView + accessor par
 * attribut (POSITION, NORMAL, COLOR_0) et un pour les indices.
 *
 * Spécifications respectées :
 *   • Header GLB 12 octets : magic 0x46546C67, version 2, longueur totale.
 *   • Chunk JSON (type 0x4E4F534A) padé à 4 octets avec des espaces (0x20).
 *   • Chunk BIN (type 0x004E4942) padé à 4 octets avec des zéros (0x00).
 *   • byteOffset de chaque bufferView aligné sur 4 octets.
 *   • POSITION inclut min/max (requis par la spec pour cet accessor).
 *   • Indices en UNSIGNED_INT (componentType 5125).
 */

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962; // bufferView.target des attributs de sommet
const ELEMENT_ARRAY_BUFFER = 34963; // bufferView.target des indices

/** Arrondit `n` au multiple de 4 supérieur ou égal (alignement glTF). */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Convertit un tableau de cellules VTK [n, id0, …, id(n-1), …] en liste plate
 * d'indices de triangles (Uint32Array). Triangulation en éventail pour n > 3 ;
 * cellules dégénérées (n < 3) ignorées. Réutilisable hors GLB.
 */
export function polysToTriangleIndices(
  polys: Int32Array | number[]
): Uint32Array {
  const out: number[] = [];
  let i = 0;
  while (i < polys.length) {
    const n = polys[i];
    if (!Number.isFinite(n) || n <= 0 || i + 1 + n > polys.length) break;
    if (n >= 3) {
      const i0 = polys[i + 1];
      for (let k = 1; k < n - 1; k++) {
        out.push(i0, polys[i + 1 + k], polys[i + 1 + k + 1]);
      }
    }
    i += 1 + n;
  }
  return Uint32Array.from(out);
}

export interface GlbMeshInput {
  /** Positions aplaties [x0,y0,z0, …] (mm, monde). */
  points: Float32Array | number[];
  /** Indices de triangles aplatis (déjà triangulés). */
  indices: Uint32Array | number[];
  /** Normales par sommet [nx,ny,nz, …] (optionnel). */
  normals?: Float32Array | number[];
  /** Couleurs RGB par sommet en 0..1 [r,g,b, …] (optionnel ; alpha forcé à 1). */
  colors?: number[] | Float32Array;
}

/**
 * Construit un .glb valide et le renvoie en `Blob` (type `model/gltf-binary`).
 * Une seule mesh / une seule primitive (mode 4 = TRIANGLES), matériau par défaut.
 */
export function meshToGlb(input: GlbMeshInput): Blob {
  const points = Float32Array.from(input.points);
  const indices = Uint32Array.from(input.indices);
  const vertexCount = Math.floor(points.length / 3);

  const normals =
    input.normals && input.normals.length === vertexCount * 3
      ? Float32Array.from(input.normals)
      : undefined;

  // COLOR_0 en VEC4 (alpha = 1). On n'inclut que si la longueur RGB correspond.
  let colors: Float32Array | undefined;
  if (input.colors && input.colors.length === vertexCount * 3) {
    colors = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
      colors[v * 4] = input.colors[v * 3];
      colors[v * 4 + 1] = input.colors[v * 3 + 1];
      colors[v * 4 + 2] = input.colors[v * 3 + 2];
      colors[v * 4 + 3] = 1.0;
    }
  }

  // min/max de POSITION (requis pour cet accessor par la spec glTF).
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexCount; v++) {
    for (let c = 0; c < 3; c++) {
      const val = points[v * 3 + c];
      if (val < min[c]) min[c] = val;
      if (val > max[c]) max[c] = val;
    }
  }
  if (vertexCount === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  // ── Disposition du buffer binaire : un bufferView par attribut, chacun aligné
  // sur 4 octets. On collecte les morceaux puis on calcule offsets/longueurs.
  interface Chunk {
    bytes: Uint8Array;
    byteLength: number;
  }
  const bufferViews: {
    byteOffset: number;
    byteLength: number;
    target: number;
  }[] = [];
  const accessors: any[] = [];
  const chunks: Chunk[] = [];
  let cursor = 0;

  const addBufferView = (
    typed: Float32Array | Uint32Array,
    target: number
  ): number => {
    const offset = align4(cursor);
    const bytes = new Uint8Array(
      typed.buffer,
      typed.byteOffset,
      typed.byteLength
    );
    chunks.push({ bytes, byteLength: typed.byteLength });
    bufferViews.push({
      byteOffset: offset,
      byteLength: typed.byteLength,
      target,
    });
    cursor = offset + typed.byteLength;
    return bufferViews.length - 1;
  };

  // POSITION (VEC3 float) avec min/max.
  const posView = addBufferView(points, ARRAY_BUFFER);
  const positionAccessor = accessors.length;
  accessors.push({
    bufferView: posView,
    componentType: FLOAT,
    count: vertexCount,
    type: "VEC3",
    min,
    max,
  });

  // NORMAL (VEC3 float) optionnel.
  let normalAccessor = -1;
  if (normals) {
    const nv = addBufferView(normals, ARRAY_BUFFER);
    normalAccessor = accessors.length;
    accessors.push({
      bufferView: nv,
      componentType: FLOAT,
      count: vertexCount,
      type: "VEC3",
    });
  }

  // COLOR_0 (VEC4 float) optionnel.
  let colorAccessor = -1;
  if (colors) {
    const cv = addBufferView(colors, ARRAY_BUFFER);
    colorAccessor = accessors.length;
    accessors.push({
      bufferView: cv,
      componentType: FLOAT,
      count: vertexCount,
      type: "VEC4",
    });
  }

  // Indices (SCALAR UNSIGNED_INT).
  const idxView = addBufferView(indices, ELEMENT_ARRAY_BUFFER);
  const indexAccessor = accessors.length;
  accessors.push({
    bufferView: idxView,
    componentType: UNSIGNED_INT,
    count: indices.length,
    type: "SCALAR",
  });

  const binByteLength = cursor; // longueur logique avant padding du chunk

  // Primitive / mesh.
  const attributes: Record<string, number> = { POSITION: positionAccessor };
  if (normalAccessor >= 0) attributes.NORMAL = normalAccessor;
  if (colorAccessor >= 0) attributes.COLOR_0 = colorAccessor;

  const gltf = {
    asset: { version: "2.0", generator: "horos-viewer glbExport" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes,
            indices: indexAccessor,
            mode: 4, // TRIANGLES
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    bufferViews: bufferViews.map(bv => ({
      buffer: 0,
      byteOffset: bv.byteOffset,
      byteLength: bv.byteLength,
      target: bv.target,
    })),
    accessors,
    buffers: [{ byteLength: binByteLength }],
  };

  // ── Assemblage du conteneur GLB ─────────────────────────────────────────
  // Chunk JSON : padé à 4 octets avec des espaces (0x20).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = align4(jsonBytes.length);
  const jsonChunk = new Uint8Array(jsonPadded);
  jsonChunk.set(jsonBytes, 0);
  jsonChunk.fill(0x20, jsonBytes.length); // espaces

  // Chunk BIN : on reconstruit le buffer en respectant les byteOffset, padé
  // à 4 octets avec des zéros (0x00).
  const binPadded = align4(binByteLength);
  const binChunk = new Uint8Array(binPadded);
  for (let i = 0; i < chunks.length; i++) {
    binChunk.set(chunks[i].bytes, bufferViews[i].byteOffset);
  }

  const headerLength = 12;
  const chunkHeaderLength = 8; // 4 (length) + 4 (type) par chunk
  const totalLength =
    headerLength +
    chunkHeaderLength +
    jsonPadded +
    chunkHeaderLength +
    binPadded;

  const out = new ArrayBuffer(totalLength);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  let off = 0;

  // Header : magic / version / longueur totale (little-endian).
  dv.setUint32(off, 0x46546c67, true); // "glTF"
  off += 4;
  dv.setUint32(off, 2, true); // version 2
  off += 4;
  dv.setUint32(off, totalLength, true);
  off += 4;

  // Chunk JSON.
  dv.setUint32(off, jsonPadded, true);
  off += 4;
  dv.setUint32(off, 0x4e4f534a, true); // "JSON"
  off += 4;
  u8.set(jsonChunk, off);
  off += jsonPadded;

  // Chunk BIN.
  dv.setUint32(off, binPadded, true);
  off += 4;
  dv.setUint32(off, 0x004e4942, true); // "BIN\0"
  off += 4;
  u8.set(binChunk, off);
  off += binPadded;

  return new Blob([out], { type: "model/gltf-binary" });
}
