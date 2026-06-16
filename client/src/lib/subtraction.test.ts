import { describe, it, expect } from "vitest";
import {
  subtractMask,
  applyPixelShift,
  PIXEL_SHIFTS,
  sumImages,
  adjustContrastBrightness,
  type PixelShift,
} from "./subtraction";

describe("subtractMask", () => {
  it("soustrait pixel à pixel (live − mask)", () => {
    expect(subtractMask([10, 20, 30], [1, 2, 3])).toEqual([9, 18, 27]);
  });

  it("conserve les valeurs négatives (pas de clamp)", () => {
    expect(subtractMask([0, 5], [3, 10])).toEqual([-3, -5]);
  });

  it("tableau vide → tableau vide", () => {
    expect(subtractMask([], [])).toEqual([]);
  });

  it("gère les flottants", () => {
    expect(subtractMask([1.5, 2.25], [0.5, 0.25])).toEqual([1, 2]);
  });

  it("lève si les tailles diffèrent", () => {
    expect(() => subtractMask([1, 2, 3], [1, 2])).toThrow(/incompatibles/);
  });

  it("ne mute pas les entrées", () => {
    const live = [5, 6];
    const mask = [1, 1];
    subtractMask(live, mask);
    expect(live).toEqual([5, 6]);
    expect(mask).toEqual([1, 1]);
  });
});

describe("PIXEL_SHIFTS", () => {
  it("expose 9 directions (8 + none)", () => {
    expect(Object.keys(PIXEL_SHIFTS).sort()).toEqual(
      ["E", "N", "NE", "NW", "S", "SE", "SW", "W", "none"].sort()
    );
  });

  it("convention écran : N vers le haut, S vers le bas", () => {
    expect(PIXEL_SHIFTS.N).toEqual({ dx: 0, dy: -1 });
    expect(PIXEL_SHIFTS.S).toEqual({ dx: 0, dy: 1 });
    expect(PIXEL_SHIFTS.E).toEqual({ dx: 1, dy: 0 });
    expect(PIXEL_SHIFTS.W).toEqual({ dx: -1, dy: 0 });
  });

  it("diagonales cohérentes", () => {
    expect(PIXEL_SHIFTS.NE).toEqual({ dx: 1, dy: -1 });
    expect(PIXEL_SHIFTS.NW).toEqual({ dx: -1, dy: -1 });
    expect(PIXEL_SHIFTS.SE).toEqual({ dx: 1, dy: 1 });
    expect(PIXEL_SHIFTS.SW).toEqual({ dx: -1, dy: 1 });
  });

  it("none est nul", () => {
    expect(PIXEL_SHIFTS.none).toEqual({ dx: 0, dy: 0 });
  });

  it("est gelé (immutable)", () => {
    expect(Object.isFrozen(PIXEL_SHIFTS)).toBe(true);
  });

  it("toutes les valeurs sont des décalages unitaires {-1,0,1}", () => {
    for (const k of Object.keys(PIXEL_SHIFTS)) {
      const s: PixelShift = PIXEL_SHIFTS[k];
      expect([-1, 0, 1]).toContain(s.dx);
      expect([-1, 0, 1]).toContain(s.dy);
    }
  });
});

describe("applyPixelShift", () => {
  // Image 3×3 de référence :
  //   1 2 3
  //   4 5 6
  //   7 8 9
  const img = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const W = 3;
  const H = 3;

  it("décalage nul (none) → identité", () => {
    expect(applyPixelShift(img, W, H, 0, 0)).toEqual(img);
  });

  it("décalage E (dx=+1) pousse vers la droite, colonne gauche à 0", () => {
    expect(applyPixelShift(img, W, H, 1, 0)).toEqual([
      0,
      1,
      2, //
      0,
      4,
      5,
      0,
      7,
      8,
    ]);
  });

  it("décalage W (dx=-1) pousse vers la gauche, colonne droite à 0", () => {
    expect(applyPixelShift(img, W, H, -1, 0)).toEqual([
      2,
      3,
      0, //
      5,
      6,
      0,
      8,
      9,
      0,
    ]);
  });

  it("décalage S (dy=+1) pousse vers le bas, ligne haute à 0", () => {
    expect(applyPixelShift(img, W, H, 0, 1)).toEqual([
      0,
      0,
      0, //
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
  });

  it("décalage N (dy=-1) pousse vers le haut, ligne basse à 0", () => {
    expect(applyPixelShift(img, W, H, 0, -1)).toEqual([
      4,
      5,
      6, //
      7,
      8,
      9,
      0,
      0,
      0,
    ]);
  });

  it("décalage diagonal SE (1,1)", () => {
    expect(applyPixelShift(img, W, H, 1, 1)).toEqual([
      0,
      0,
      0, //
      0,
      1,
      2,
      0,
      4,
      5,
    ]);
  });

  it("applique chaque direction de PIXEL_SHIFTS sans erreur", () => {
    for (const k of Object.keys(PIXEL_SHIFTS)) {
      const { dx, dy } = PIXEL_SHIFTS[k];
      const r = applyPixelShift(img, W, H, dx, dy);
      expect(r).toHaveLength(img.length);
    }
  });

  it("décalage supérieur à l'image → tout à 0", () => {
    expect(applyPixelShift(img, W, H, 5, 0)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(applyPixelShift(img, W, H, 0, -5)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("tronque les décalages fractionnaires", () => {
    expect(applyPixelShift(img, W, H, 1.9, 0)).toEqual(
      applyPixelShift(img, W, H, 1, 0)
    );
  });

  it("image non carrée (largeur ≠ hauteur)", () => {
    // 2×3 :
    //   1 2
    //   3 4
    //   5 6
    const rect = [1, 2, 3, 4, 5, 6];
    expect(applyPixelShift(rect, 2, 3, 1, 0)).toEqual([0, 1, 0, 3, 0, 5]);
  });

  it("image vide (0×0) → vide", () => {
    expect(applyPixelShift([], 0, 0, 1, 1)).toEqual([]);
  });

  it("ne mute pas l'entrée", () => {
    const copy = [...img];
    applyPixelShift(img, W, H, 1, 1);
    expect(img).toEqual(copy);
  });

  it("lève si dimensions ≠ longueur", () => {
    expect(() => applyPixelShift([1, 2, 3], 2, 2, 0, 0)).toThrow(/pixels/);
  });

  it("lève si dimensions non entières ou négatives", () => {
    expect(() => applyPixelShift([1], 1.5, 1, 0, 0)).toThrow(/dimensions/);
    expect(() => applyPixelShift([1], -1, 1, 0, 0)).toThrow(/dimensions/);
  });
});

describe("sumImages", () => {
  it("somme brute (factor=1)", () => {
    expect(
      sumImages(
        [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
        1
      )
    ).toEqual([9, 12]);
  });

  it("moyenne (factor=1/N)", () => {
    expect(
      sumImages(
        [
          [2, 4],
          [4, 8],
        ],
        0.5
      )
    ).toEqual([3, 6]);
  });

  it("une seule image → elle-même fois factor", () => {
    expect(sumImages([[10, 20]], 1)).toEqual([10, 20]);
    expect(sumImages([[10, 20]], 0.1)).toEqual([1, 2]);
  });

  it("liste d'images vide → tableau vide", () => {
    expect(sumImages([], 1)).toEqual([]);
  });

  it("images de pixels vides → vide", () => {
    expect(sumImages([[], []], 1)).toEqual([]);
  });

  it("facteur négatif (inversion)", () => {
    expect(sumImages([[1, 2]], -1)).toEqual([-1, -2]);
  });

  it("facteur 0 → tout à 0", () => {
    expect(
      sumImages(
        [
          [5, 6],
          [7, 8],
        ],
        0
      )
    ).toEqual([0, 0]);
  });

  it("lève si une image a une taille différente", () => {
    expect(() =>
      sumImages(
        [
          [1, 2],
          [1, 2, 3],
        ],
        1
      )
    ).toThrow(/sumImages/);
  });

  it("ne mute pas les entrées", () => {
    const a = [1, 2];
    const b = [3, 4];
    sumImages([a, b], 1);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([3, 4]);
  });
});

describe("adjustContrastBrightness", () => {
  it("deltas nuls → identité", () => {
    expect(adjustContrastBrightness([10, 20, 30], 0, 0)).toEqual([10, 20, 30]);
  });

  it("luminosité seule décale", () => {
    expect(adjustContrastBrightness([10, 20], 0, 5)).toEqual([15, 25]);
  });

  it("contraste positif amplifie (gain = 1 + delta)", () => {
    expect(adjustContrastBrightness([10, 20], 1, 0)).toEqual([20, 40]);
  });

  it("contrastDelta = -1 aplatit à la seule luminosité", () => {
    expect(adjustContrastBrightness([10, 20, 30], -1, 7)).toEqual([7, 7, 7]);
  });

  it("combine gain puis offset", () => {
    // gain = 2, offset = 3 → x*2+3
    expect(adjustContrastBrightness([1, 2, 3], 1, 3)).toEqual([5, 7, 9]);
  });

  it("autorise valeurs négatives (pas de clamp)", () => {
    expect(adjustContrastBrightness([0, 1], 0, -10)).toEqual([-10, -9]);
  });

  it("tableau vide → vide", () => {
    expect(adjustContrastBrightness([], 0.5, 1)).toEqual([]);
  });

  it("ne mute pas l'entrée", () => {
    const px = [1, 2, 3];
    adjustContrastBrightness(px, 1, 1);
    expect(px).toEqual([1, 2, 3]);
  });
});

describe("intégration DSA : live − masque recalé", () => {
  it("un masque parfaitement aligné annule l'anatomie fixe", () => {
    // anatomie fixe partout + un vaisseau (+50) dans le live
    const mask = [100, 100, 100, 100];
    const live = [100, 150, 100, 100];
    expect(subtractMask(live, mask)).toEqual([0, 50, 0, 0]);
  });

  it("recale le masque d'un pixel avant soustraction", () => {
    // mask décalé d'un pixel vs live → on recale puis soustrait
    const W = 2;
    const H = 2;
    const live = [10, 20, 30, 40];
    const maskShifted = [0, 10, 0, 30]; // = live shifté E
    const recaled = applyPixelShift(maskShifted, W, H, -1, 0); // annule le shift
    expect(recaled).toEqual([10, 0, 30, 0]);
  });
});
