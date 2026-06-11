import { describe, it, expect } from "vitest";
import {
  growRegion2D,
  growRegion3D,
  countMask,
  type Connectivity2D,
} from "./regionGrow";

// Petit utilitaire : construit un tableau de la grille attendue (lignes) en
// aplatissant une matrice 2D ligne par ligne (y croissant).
function flatten2D(rows: number[][]): {
  pixels: number[];
  w: number;
  h: number;
} {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const pixels: number[] = [];
  for (const row of rows) for (const v of row) pixels.push(v);
  return { pixels, w, h };
}

// Reconstruit un masque 2D en matrice pour des assertions lisibles.
function toMatrix(mask: Uint8Array, w: number, h: number): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) row.push(mask[y * w + x]);
    out.push(row);
  }
  return out;
}

describe("growRegion2D — nominal", () => {
  it("agrège une région homogène simple (4-connexité)", () => {
    // 3x3 plein de 100 → tout est dans [50,150].
    const { pixels, w, h } = flatten2D([
      [100, 100, 100],
      [100, 100, 100],
      [100, 100, 100],
    ]);
    const mask = growRegion2D(pixels, w, h, [1, 1], 50, 150);
    expect(countMask(mask)).toBe(9);
    expect(mask.every(v => v === 1)).toBe(true);
  });

  it("exclut les pixels hors de la fenêtre d'intensité", () => {
    // Croix de 100 au milieu, coins à 0 (hors [50,150]).
    const { pixels, w, h } = flatten2D([
      [0, 100, 0],
      [100, 100, 100],
      [0, 100, 0],
    ]);
    const mask = growRegion2D(pixels, w, h, [1, 1], 50, 150);
    expect(toMatrix(mask, w, h)).toEqual([
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ]);
  });

  it("ne franchit pas une barrière en 4-connexité mais oui en 8-connexité", () => {
    // Deux blocs diagonaux de 100 séparés par des 0.
    const grid = [
      [100, 0, 0],
      [0, 100, 0],
      [0, 0, 100],
    ];
    const { pixels, w, h } = flatten2D(grid);
    const m4 = growRegion2D(pixels, w, h, [0, 0], 50, 150, 4);
    // En 4-connexité, seul le pixel graine est atteint.
    expect(countMask(m4)).toBe(1);
    expect(m4[0]).toBe(1);
    const m8 = growRegion2D(pixels, w, h, [0, 0], 50, 150, 8);
    // En 8-connexité la diagonale relie les trois.
    expect(countMask(m8)).toBe(3);
    expect(m8[0]).toBe(1);
    expect(m8[4]).toBe(1);
    expect(m8[8]).toBe(1);
  });

  it("ne capture pas une région déconnectée de même intensité", () => {
    // Deux îlots de 100 séparés par une colonne de 0.
    const { pixels, w, h } = flatten2D([
      [100, 0, 100],
      [100, 0, 100],
    ]);
    const mask = growRegion2D(pixels, w, h, [0, 0], 50, 150);
    // Seul l'îlot de gauche (colonne x=0) est atteint.
    expect(toMatrix(mask, w, h)).toEqual([
      [1, 0, 0],
      [1, 0, 0],
    ]);
  });

  it("respecte des seuils stricts (bornes incluses)", () => {
    const { pixels, w, h } = flatten2D([
      [10, 20, 30],
      [40, 50, 60],
    ]);
    // Fenêtre [20,50] → 20,30,40,50 connectés depuis la graine (1,0)=20.
    const mask = growRegion2D(pixels, w, h, [1, 0], 20, 50);
    expect(toMatrix(mask, w, h)).toEqual([
      [0, 1, 1],
      [1, 1, 0],
    ]);
  });

  it("échange les bornes si lower > upper", () => {
    const { pixels, w, h } = flatten2D([
      [100, 100],
      [100, 100],
    ]);
    const mask = growRegion2D(pixels, w, h, [0, 0], 150, 50);
    expect(countMask(mask)).toBe(4);
  });
});

describe("growRegion2D — bords et cas dégénérés", () => {
  it("graine hors fenêtre → masque vide", () => {
    const { pixels, w, h } = flatten2D([
      [0, 0],
      [0, 0],
    ]);
    const mask = growRegion2D(pixels, w, h, [0, 0], 50, 150);
    expect(countMask(mask)).toBe(0);
    expect(mask.length).toBe(4);
  });

  it("dimensions nulles ou négatives → masque de taille 0", () => {
    expect(growRegion2D([], 0, 0, [0, 0], 0, 100).length).toBe(0);
    expect(growRegion2D([1], -3, 2, [0, 0], 0, 100).length).toBe(0);
    expect(growRegion2D([1], 2, -1, [0, 0], 0, 100).length).toBe(0);
  });

  it("tableau de pixels trop court → masque entièrement à 0", () => {
    // 3x3 = 9 attendus mais on n'en fournit que 4.
    const mask = growRegion2D([100, 100, 100, 100], 3, 3, [0, 0], 0, 200);
    expect(mask.length).toBe(9);
    expect(countMask(mask)).toBe(0);
  });

  it("graine hors champ est bornée au champ", () => {
    const { pixels, w, h } = flatten2D([
      [100, 100],
      [100, 100],
    ]);
    // Graine [99,99] bornée vers (1,1) qui vaut 100 → région pleine.
    const mask = growRegion2D(pixels, w, h, [99, 99], 50, 150);
    expect(countMask(mask)).toBe(4);
  });

  it("seuils non finis → masque à 0", () => {
    const { pixels, w, h } = flatten2D([
      [100, 100],
      [100, 100],
    ]);
    expect(countMask(growRegion2D(pixels, w, h, [0, 0], NaN, 150))).toBe(0);
    expect(countMask(growRegion2D(pixels, w, h, [0, 0], 50, Infinity))).toBe(0);
  });

  it("ignore les pixels non finis (NaN) sans les inclure", () => {
    const pixels = [100, NaN, 100, 100];
    const mask = growRegion2D(pixels, 2, 2, [0, 0], 50, 150);
    // (0,0)=100 et (0,1)=100 connectés verticalement ; (1,0)=NaN exclu ;
    // (1,1)=100 atteint via (0,1).
    expect(toMatrix(mask, 2, 2)).toEqual([
      [1, 0],
      [1, 1],
    ]);
  });

  it("image 1x1 avec graine valide → un seul pixel", () => {
    const mask = growRegion2D([42], 1, 1, [0, 0], 0, 100);
    expect(countMask(mask)).toBe(1);
    expect(mask[0]).toBe(1);
  });

  it("accepte une Uint16Array comme entrée (ArrayLike)", () => {
    const pixels = Uint16Array.from([10, 10, 10, 10]);
    const mask = growRegion2D(pixels, 2, 2, [0, 0], 5, 15);
    expect(countMask(mask)).toBe(4);
  });

  it("ne déborde pas la pile sur une grande image homogène", () => {
    const w = 200;
    const h = 200;
    const pixels = new Array(w * h).fill(100);
    const mask = growRegion2D(pixels, w, h, [100, 100], 50, 150);
    expect(countMask(mask)).toBe(w * h);
  });
});

describe("growRegion3D — nominal", () => {
  it("agrège un volume homogène 2x2x2 (6-connexité)", () => {
    const volume = new Array(8).fill(100);
    const mask = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 50, 150);
    expect(countMask(mask)).toBe(8);
  });

  it("propage à travers les coupes (axe z)", () => {
    // 1x1x3 : trois voxels alignés en z, tous à 100.
    const volume = [100, 100, 100];
    const mask = growRegion3D(volume, [1, 1, 3], [0, 0, 0], 50, 150);
    expect(countMask(mask)).toBe(3);
  });

  it("ne franchit pas une coupe hors fenêtre (barrière en z)", () => {
    // 1x1x3 : milieu à 0 sépare les deux extrémités.
    const volume = [100, 0, 100];
    const mask = growRegion3D(volume, [1, 1, 3], [0, 0, 0], 50, 150);
    // Seule la première coupe (z=0) est atteinte.
    expect(countMask(mask)).toBe(1);
    expect(mask[0]).toBe(1);
  });

  it("6-connexité n'atteint pas un voisin purement diagonal, 26 oui", () => {
    // 2x2x2 : graine (0,0,0)=100 et coin opposé (1,1,1)=100, reste 0.
    // idx: x + 2y + 4z. (0,0,0)=0 ; (1,1,1)=1+2+4=7.
    const volume = [100, 0, 0, 0, 0, 0, 0, 100];
    const m6 = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 50, 150, 6);
    expect(countMask(m6)).toBe(1); // seul le voxel graine
    const m26 = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 50, 150, 26);
    expect(countMask(m26)).toBe(2); // le coin diagonal est relié
    expect(m26[0]).toBe(1);
    expect(m26[7]).toBe(1);
  });

  it("segmente un sous-cube et exclut le reste", () => {
    // 3x3x3 : seuls les voxels avec z=0 valent 100, le reste 0.
    const nx = 3,
      ny = 3,
      nz = 3;
    const volume = new Array(nx * ny * nz).fill(0);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        volume[0 * nx * ny + y * nx + x] = 100; // coupe z=0
      }
    }
    const mask = growRegion3D(volume, [nx, ny, nz], [0, 0, 0], 50, 150);
    expect(countMask(mask)).toBe(9); // toute la coupe z=0
  });

  it("échange les bornes lo/hi si inversées", () => {
    const volume = new Array(8).fill(100);
    const mask = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 150, 50);
    expect(countMask(mask)).toBe(8);
  });
});

describe("growRegion3D — bords et cas dégénérés", () => {
  it("graine hors fenêtre → masque vide de bonne taille", () => {
    const volume = new Array(8).fill(0);
    const mask = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 50, 150);
    expect(mask.length).toBe(8);
    expect(countMask(mask)).toBe(0);
  });

  it("dimensions invalides → masque de taille 0", () => {
    expect(growRegion3D([], [0, 2, 2], [0, 0, 0], 0, 100).length).toBe(0);
    expect(growRegion3D([1], [2, -1, 2], [0, 0, 0], 0, 100).length).toBe(0);
  });

  it("volume trop court → masque à 0", () => {
    const mask = growRegion3D([100, 100], [2, 2, 2], [0, 0, 0], 0, 200);
    expect(mask.length).toBe(8);
    expect(countMask(mask)).toBe(0);
  });

  it("graine hors volume bornée au volume", () => {
    const volume = new Array(8).fill(100);
    const mask = growRegion3D(volume, [2, 2, 2], [50, 50, 50], 50, 150);
    expect(countMask(mask)).toBe(8);
  });

  it("seuils non finis → masque à 0", () => {
    const volume = new Array(8).fill(100);
    expect(
      countMask(growRegion3D(volume, [2, 2, 2], [0, 0, 0], NaN, 150))
    ).toBe(0);
  });

  it("ignore les voxels NaN", () => {
    const volume = [100, NaN, 100, 100, 100, 100, 100, 100];
    const mask = growRegion3D(volume, [2, 2, 2], [0, 0, 0], 50, 150);
    // 7 voxels valides connectés (le NaN à idx 1 est exclu mais n'isole rien).
    expect(countMask(mask)).toBe(7);
    expect(mask[1]).toBe(0);
  });

  it("volume 1x1x1 → un seul voxel", () => {
    const mask = growRegion3D([7], [1, 1, 1], [0, 0, 0], 0, 100);
    expect(countMask(mask)).toBe(1);
  });
});

describe("countMask", () => {
  it("compte correctement les 1", () => {
    expect(countMask(new Uint8Array([1, 0, 1, 1, 0]))).toBe(3);
    expect(countMask([])).toBe(0);
  });
});

describe("déterminisme", () => {
  it("produit le même masque à chaque appel", () => {
    const { pixels, w, h } = flatten2D([
      [100, 100, 0],
      [0, 100, 100],
      [100, 0, 100],
    ]);
    const conn: Connectivity2D = 8;
    const a = growRegion2D(pixels, w, h, [0, 0], 50, 150, conn);
    const b = growRegion2D(pixels, w, h, [0, 0], 50, 150, conn);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
