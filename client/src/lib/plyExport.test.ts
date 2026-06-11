import { describe, it, expect } from "vitest";
import { meshToBinaryPly } from "./plyExport";

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function splitHeader(bytes: Uint8Array): {
  header: string;
  bodyOffset: number;
} {
  const text = new TextDecoder().decode(bytes);
  const marker = "end_header\n";
  const idx = text.indexOf(marker);
  return { header: text.slice(0, idx), bodyOffset: idx + marker.length };
}

describe("meshToBinaryPly", () => {
  it("1 triangle colorié : en-tête + longueur binaire + valeurs décodées", async () => {
    // 3 sommets, 1 face. Couleurs 0..1 (rouge pur, vert pur, bleu pur).
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const polys = [3, 0, 1, 2];
    const colors = [1, 0, 0, 0, 1, 0, 0, 0, 1];

    const blob = meshToBinaryPly({ points, polys, colors });
    const bytes = await blobBytes(blob);
    const { header, bodyOffset } = splitHeader(bytes);

    expect(header).toContain("format binary_little_endian 1.0");
    expect(header).toContain("element vertex 3");
    expect(header).toContain("property float x");
    expect(header).toContain("property uchar red");
    expect(header).toContain("element face 1");
    expect(header).toContain("property list uchar int vertex_indices");
    // Pas de normales fournies → pas de propriétés nx/ny/nz.
    expect(header).not.toContain("property float nx");

    // Corps : 3 sommets × (3 float + 3 uchar) + 1 face × (1 uchar + 3 int32).
    const vertexBytes = 3 * (3 * 4 + 3);
    const faceBytes = 1 * (1 + 3 * 4);
    expect(bytes.byteLength).toBe(bodyOffset + vertexBytes + faceBytes);

    const dv = new DataView(
      bytes.buffer,
      bytes.byteOffset + bodyOffset,
      vertexBytes + faceBytes
    );
    // Premier sommet : position (0,0,0), couleur (255,0,0).
    expect(dv.getFloat32(0, true)).toBe(0);
    expect(dv.getFloat32(4, true)).toBe(0);
    expect(dv.getFloat32(8, true)).toBe(0);
    expect(dv.getUint8(12)).toBe(255);
    expect(dv.getUint8(13)).toBe(0);
    expect(dv.getUint8(14)).toBe(0);
    // Deuxième sommet : position (1,0,0), couleur (0,255,0).
    expect(dv.getFloat32(15, true)).toBe(1);
    expect(dv.getUint8(15 + 12)).toBe(0);
    expect(dv.getUint8(15 + 13)).toBe(255);

    // Face : compte 3 puis indices 0,1,2.
    const faceOff = vertexBytes;
    expect(dv.getUint8(faceOff)).toBe(3);
    expect(dv.getInt32(faceOff + 1, true)).toBe(0);
    expect(dv.getInt32(faceOff + 5, true)).toBe(1);
    expect(dv.getInt32(faceOff + 9, true)).toBe(2);
  });

  it("inclut les normales quand elles sont fournies et de bonne longueur", async () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const polys = [3, 0, 1, 2];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const blob = meshToBinaryPly({ points, polys, normals });
    const { header } = splitHeader(await blobBytes(blob));
    expect(header).toContain("property float nx");
    expect(header).not.toContain("property uchar red");
  });

  it("triangule un quad en éventail (2 faces)", async () => {
    const points = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const polys = [4, 0, 1, 2, 3];
    const blob = meshToBinaryPly({ points, polys });
    const { header } = splitHeader(await blobBytes(blob));
    expect(header).toContain("element face 2");
  });

  it("longueur de couleurs incohérente → ignorée (pas de propriétés couleur)", async () => {
    const points = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const polys = [3, 0, 1, 2];
    const colors = [1, 0, 0]; // longueur 3 ≠ 9 attendu
    const blob = meshToBinaryPly({ points, polys, colors });
    const { header } = splitHeader(await blobBytes(blob));
    expect(header).not.toContain("property uchar red");
  });
});
