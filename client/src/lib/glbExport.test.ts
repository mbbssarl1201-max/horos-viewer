import { describe, it, expect } from "vitest";
import { meshToGlb, polysToTriangleIndices } from "./glbExport";

async function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

/** Parse minimal d'un GLB → header + JSON décodé + longueur du chunk BIN. */
function parseGlb(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const totalLength = dv.getUint32(8, true);

  let off = 12;
  const jsonLength = dv.getUint32(off, true);
  const jsonType = dv.getUint32(off + 4, true);
  off += 8;
  const jsonText = new TextDecoder().decode(
    new Uint8Array(buf, off, jsonLength)
  );
  off += jsonLength;

  const binLength = dv.getUint32(off, true);
  const binType = dv.getUint32(off + 4, true);

  return {
    magic,
    version,
    totalLength,
    jsonType,
    binType,
    binLength,
    json: JSON.parse(jsonText),
  };
}

describe("polysToTriangleIndices", () => {
  it("quad [4,0,1,2,3] → 6 indices (2 triangles)", () => {
    const idx = polysToTriangleIndices([4, 0, 1, 2, 3]);
    expect(idx).toBeInstanceOf(Uint32Array);
    expect(idx.length).toBe(6);
    expect([...idx]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("ignore les cellules dégénérées (n < 3)", () => {
    const idx = polysToTriangleIndices([2, 0, 1, 3, 0, 1, 2]);
    expect([...idx]).toEqual([0, 1, 2]);
  });
});

describe("meshToGlb", () => {
  it("1 triangle → GLB valide (header, accessors, chunk BIN)", async () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const indices = [0, 1, 2];
    const blob = meshToGlb({ points, indices });
    expect(blob.type).toBe("model/gltf-binary");

    const buf = await blobBuffer(blob);
    const g = parseGlb(buf);

    // Header.
    expect(g.magic).toBe(0x46546c67);
    expect(g.version).toBe(2);
    expect(g.totalLength).toBe(buf.byteLength);
    expect(g.jsonType).toBe(0x4e4f534a); // "JSON"
    expect(g.binType).toBe(0x004e4942); // "BIN\0"

    // Accessors POSITION (count 3 + min/max) et indices (count 3, UINT).
    const json = g.json;
    const prim = json.meshes[0].primitives[0];
    expect(prim.mode).toBe(4);
    const posAcc = json.accessors[prim.attributes.POSITION];
    expect(posAcc.type).toBe("VEC3");
    expect(posAcc.count).toBe(3);
    expect(posAcc.min).toEqual([0, 0, 0]);
    expect(posAcc.max).toEqual([1, 1, 0]);
    const idxAcc = json.accessors[prim.indices];
    expect(idxAcc.count).toBe(3);
    expect(idxAcc.componentType).toBe(5125); // UNSIGNED_INT
    expect(idxAcc.type).toBe("SCALAR");

    // Le chunk BIN couvre POSITION (3×3×4=36) + indices (3×4=12) = 48 octets,
    // padé à 4 (déjà aligné). Le buffer logique doit valoir 48.
    expect(json.buffers[0].byteLength).toBe(48);
    expect(g.binLength).toBe(48);
  });

  it("inclut NORMAL et COLOR_0 (VEC4, alpha 1) quand fournis", async () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const indices = [0, 1, 2];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const colors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const blob = meshToGlb({ points, indices, normals, colors });
    const g = parseGlb(await blobBuffer(blob));
    const prim = g.json.meshes[0].primitives[0];
    expect(prim.attributes.NORMAL).toBeDefined();
    expect(prim.attributes.COLOR_0).toBeDefined();
    const colAcc = g.json.accessors[prim.attributes.COLOR_0];
    expect(colAcc.type).toBe("VEC4");
    expect(colAcc.count).toBe(3);
  });
});
