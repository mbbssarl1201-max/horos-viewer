import { describe, it, expect } from "vitest";
import { erode, dilate, open, close } from "./morphology";

// ── Helpers de test ──────────────────────────────────────────────────────────

/** Construit un Uint8Array depuis un tableau de lignes de 0/1 (lecture visuelle). */
function fromRows(rows: number[][]): {
  mask: Uint8Array;
  width: number;
  height: number;
} {
  const height = rows.length;
  const width = height > 0 ? rows[0].length : 0;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(rows[y].length).toBe(width); // lignes homogènes
    for (let x = 0; x < width; x++) mask[y * width + x] = rows[y][x];
  }
  return { mask, width, height };
}

/** Convertit un masque en tableau de lignes pour comparaison lisible. */
function toRows(mask: Uint8Array, width: number, height: number): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(mask[y * width + x]);
    rows.push(row);
  }
  return rows;
}

describe("morphology — érosion (carré, r=1)", () => {
  it("ronge le contour d'un carré plein 3×3 → un seul pixel central", () => {
    // Carré 3×3 dans une grille 5×5.
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
    ]);
    const out = erode(mask, width, height, 1);
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
  });

  it("efface complètement un carré 2×2 (pas de pixel avec voisinage 3×3 plein)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [0, 1, 1, 0],
      [0, 0, 0, 0],
    ]);
    const out = erode(mask, width, height, 1);
    expect(out.every(v => v === 0)).toBe(true);
  });

  it("les bords comptent comme fond : seul le centre survit dans un 3×3 plein", () => {
    const { mask, width, height } = fromRows([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const out = erode(mask, width, height, 1);
    // Seul le centre (1,1) a son voisinage 3×3 entièrement dans la grille ET à 1.
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
  });
});

describe("morphology — dilatation (carré, r=1)", () => {
  it("étend un point isolé en un carré 3×3", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const out = dilate(mask, width, height, 1);
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
    ]);
  });

  it("dilatation puis érosion d'un point isolé redonne le point (réversibilité locale)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const dil = dilate(mask, width, height, 1);
    const back = erode(dil, width, height, 1);
    expect(toRows(back, width, height)).toEqual(toRows(mask, width, height));
  });

  it("gère la dilatation au coin (pixel sur le bord)", () => {
    const { mask, width, height } = fromRows([
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const out = dilate(mask, width, height, 1);
    expect(toRows(out, width, height)).toEqual([
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 0],
    ]);
  });
});

describe("morphology — élément structurant « croix »", () => {
  it("dilatation croix d'un point isolé donne un plus (+)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const out = dilate(mask, width, height, 1, { shape: "cross" });
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
  });

  it("érosion croix d'un carré 3×3 ne garde que le centre (comme le carré ici)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
    ]);
    const out = erode(mask, width, height, 1, { shape: "cross" });
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
  });

  it("érosion croix d'une croix (+) garde le centre car la croix ⊆ croix décalée échoue aux bouts", () => {
    // Un + : le centre a ses 4 voisins cardinaux à 1 → reste. Les bouts non.
    const { mask, width, height } = fromRows([
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [1, 1, 1, 1, 1],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
    ]);
    const out = erode(mask, width, height, 1, { shape: "cross" });
    expect(toRows(out, width, height)).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
  });
});

describe("morphology — opening / closing", () => {
  it("opening retire une saillie d'un pixel attachée à un bloc", () => {
    // Bloc 3×3 plein + une excroissance d'un pixel à droite du milieu.
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0, 0],
      [0, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ]);
    const out = open(mask, width, height, 1, { shape: "square" });
    // La saillie (ligne 2, col 4) ne survit pas à l'érosion → disparue.
    expect(out[2 * width + 4]).toBe(0);
    // Le centre du bloc reste (le 3×3 redevient présent après reconstruction).
    expect(out[2 * width + 2]).toBe(1);
  });

  it("closing bouche un trou d'un pixel au centre d'un bloc plein", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 1, 0, 1, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
    ]);
    const out = close(mask, width, height, 1, { shape: "square" });
    expect(out[2 * width + 2]).toBe(1); // le trou est rebouché
  });

  it("opening est idempotent sur un grand carré plein (au cœur)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ]);
    const once = open(mask, width, height, 1);
    const twice = open(once, width, height, 1);
    expect(toRows(twice, width, height)).toEqual(toRows(once, width, height));
  });
});

describe("morphology — rayon r=2", () => {
  it("dilatation carré r=2 d'un point isolé donne un carré 5×5", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ]);
    const out = dilate(mask, width, height, 2);
    let count = 0;
    out.forEach(v => (count += v));
    expect(count).toBe(25); // 5×5
    expect(out[1 * width + 1]).toBe(1);
    expect(out[5 * width + 5]).toBe(1);
    expect(out[0 * width + 0]).toBe(0);
  });

  it("érosion carré r=2 d'un carré 5×5 plein → un seul pixel central", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 0, 0, 0, 0, 0, 0],
    ]);
    const out = erode(mask, width, height, 2);
    let count = 0;
    out.forEach(v => (count += v));
    expect(count).toBe(1);
    expect(out[3 * width + 3]).toBe(1);
  });
});

describe("morphology — normalisation et pureté", () => {
  it("normalise les valeurs non binaires en 0/1 en sortie", () => {
    const mask = new Uint8Array([0, 5, 255, 0]);
    const out = dilate(mask, 4, 1, 0); // r=0 ⇒ identité normalisée
    expect(Array.from(out)).toEqual([0, 1, 1, 0]);
  });

  it("rayon 0 = identité (érosion comme dilatation)", () => {
    const { mask, width, height } = fromRows([
      [1, 0, 1],
      [0, 1, 0],
    ]);
    expect(Array.from(erode(mask, width, height, 0))).toEqual(Array.from(mask));
    expect(Array.from(dilate(mask, width, height, 0))).toEqual(
      Array.from(mask)
    );
  });

  it("rayon négatif ou non fini traité comme 0 (identité)", () => {
    const { mask, width, height } = fromRows([
      [1, 1],
      [1, 0],
    ]);
    expect(Array.from(erode(mask, width, height, -3))).toEqual(
      Array.from(mask)
    );
    expect(Array.from(dilate(mask, width, height, NaN))).toEqual(
      Array.from(mask)
    );
  });

  it("ne modifie PAS le masque d'entrée (pureté)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
    const copy = Uint8Array.from(mask);
    dilate(mask, width, height, 1);
    erode(mask, width, height, 1);
    open(mask, width, height, 1);
    close(mask, width, height, 1);
    expect(Array.from(mask)).toEqual(Array.from(copy));
  });

  it("renvoie un nouvel objet distinct de l'entrée", () => {
    const { mask, width, height } = fromRows([[1, 0]]);
    const out = dilate(mask, width, height, 1);
    expect(out).not.toBe(mask);
  });
});

describe("morphology — cas dégénérés et erreurs", () => {
  it("masque vide (0×0) → sortie vide", () => {
    const empty = new Uint8Array(0);
    expect(erode(empty, 0, 0, 1).length).toBe(0);
    expect(dilate(empty, 0, 0, 1).length).toBe(0);
  });

  it("masque tout à zéro reste à zéro (dilatation et érosion)", () => {
    const { mask, width, height } = fromRows([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(dilate(mask, width, height, 1).every(v => v === 0)).toBe(true);
    expect(erode(mask, width, height, 2).every(v => v === 0)).toBe(true);
  });

  it("masque 1×1 plein : érosion l'efface (bords = fond), dilatation le garde", () => {
    const mask = new Uint8Array([1]);
    expect(Array.from(erode(mask, 1, 1, 1))).toEqual([0]);
    expect(Array.from(dilate(mask, 1, 1, 1))).toEqual([1]);
  });

  it("lève une erreur si longueur du masque ≠ width×height", () => {
    const mask = new Uint8Array([1, 0, 1]);
    expect(() => erode(mask, 2, 2, 1)).toThrow();
    expect(() => dilate(mask, 5, 1, 1)).toThrow();
  });

  it("lève une erreur si dimensions négatives ou non entières", () => {
    const mask = new Uint8Array(4);
    expect(() => erode(mask, -2, -2, 1)).toThrow();
    expect(() => dilate(mask, 2.5, 1, 1)).toThrow();
  });
});
