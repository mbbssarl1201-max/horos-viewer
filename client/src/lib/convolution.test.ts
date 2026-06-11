import { describe, it, expect } from "vitest";
import {
  CONVOLUTION_KERNELS,
  applyKernel,
  applyNamedFilter,
  kernelSum,
  validateKernel,
  type Kernel,
} from "./convolution";

// Noyau identité 3×3 : la sortie doit être égale à l'entrée (à divisor 1).
const IDENTITY: Kernel = [
  [0, 0, 0],
  [0, 1, 0],
  [0, 0, 0],
];

describe("kernelSum", () => {
  it("somme tous les coefficients", () => {
    expect(kernelSum(IDENTITY)).toBe(1);
    expect(
      kernelSum([
        [1, 2, 1],
        [2, 4, 2],
        [1, 2, 1],
      ])
    ).toBe(16);
    expect(
      kernelSum([
        [-1, -1, -1],
        [-1, 8, -1],
        [-1, -1, -1],
      ])
    ).toBe(0);
  });
});

describe("validateKernel", () => {
  it("accepte un noyau impair rectangulaire", () => {
    expect(validateKernel(IDENTITY)).toBeNull();
    expect(
      validateKernel([
        [1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1],
      ])
    ).toBeNull(); // 3×5, dimensions impaires
  });

  it("rejette un noyau vide", () => {
    expect(validateKernel([])).toBe("Noyau vide");
  });

  it("rejette des dimensions paires", () => {
    expect(
      validateKernel([
        [1, 1],
        [1, 1],
      ])
    ).toBe("Dimensions du noyau doivent être impaires");
  });

  it("rejette un noyau non rectangulaire", () => {
    expect(
      // Hauteur 3 (impaire) pour passer la parité, ligne du milieu plus courte.
      validateKernel([
        [1, 1, 1],
        [1, 1],
        [1, 1, 1],
      ] as Kernel)
    ).toBe("Noyau non rectangulaire");
  });

  it("rejette un coefficient non fini", () => {
    expect(
      validateKernel([
        [0, 0, 0],
        [0, NaN, 0],
        [0, 0, 0],
      ])
    ).toBe("Coefficient de noyau non fini");
  });

  it("rejette une largeur nulle", () => {
    expect(validateKernel([[]])).toBe("Noyau de largeur nulle");
  });
});

describe("applyKernel — noyau identité", () => {
  it("reproduit l'image à l'identique (matrice 3×3)", () => {
    const img = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = applyKernel(img, 3, 3, IDENTITY, 1, 0);
    expect(Array.from(out)).toEqual(img);
  });

  it("renvoie bien un Float32Array sans muter l'entrée", () => {
    const img = new Float32Array([10, 20, 30, 40]);
    const out = applyKernel(img, 2, 2, IDENTITY, 1, 0);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(img)).toEqual([10, 20, 30, 40]); // entrée intacte
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
    expect(out).not.toBe(img);
  });
});

describe("applyKernel — gestion des bords par clamp", () => {
  it("flou moyen 3×3 sur image constante = même constante (clamp)", () => {
    // Image uniforme : tout voisin (y compris bord répliqué) vaut 5.
    const img = new Array(9).fill(5);
    const blur: Kernel = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ];
    const out = applyKernel(img, 3, 3, blur, 9, 0);
    for (const v of out) expect(v).toBeCloseTo(5, 6);
  });

  it("clamp réplique le pixel de bord (image 1×1)", () => {
    // Une seule valeur : tous les voisins sont clampés sur elle.
    const out = applyKernel(
      [7],
      1,
      1,
      [
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ],
      9,
      0
    );
    expect(out[0]).toBeCloseTo(7, 6);
  });

  it("calcule un coin avec réplication de bord (moyenne 3×3)", () => {
    // Image 2×2 : [[1,2],[3,4]].
    // Coin (0,0) : voisinage clampé = pixels {1,1,2, 1,1,2, 3,3,4}
    //  -> somme = 1+1+2 +1+1+2 +3+3+4 = 18 ; /9 = 2.
    const img = [1, 2, 3, 4];
    const avg: Kernel = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ];
    const out = applyKernel(img, 2, 2, avg, 9, 0);
    expect(out[0]).toBeCloseTo(18 / 9, 6); // 2
    // Coin (1,1)=valeur 4 : voisinage clampé = {1,2,2, 3,4,4, 3,4,4}
    //  -> somme = 1+2+2 +3+4+4 +3+4+4 = 27 ; /9 = 3.
    expect(out[3]).toBeCloseTo(27 / 9, 6); // 3
  });
});

describe("applyKernel — divisor et bias", () => {
  it("applique le divisor (gaussien) sur image uniforme", () => {
    const img = new Array(9).fill(8);
    const gauss: Kernel = [
      [1, 2, 1],
      [2, 4, 2],
      [1, 2, 1],
    ];
    const out = applyKernel(img, 3, 3, gauss, 16, 0);
    // Somme des poids = 16, image uniforme 8 -> (16*8)/16 = 8.
    for (const v of out) expect(v).toBeCloseTo(8, 6);
  });

  it("applique le bias additif", () => {
    // Noyau somme nulle sur image uniforme -> 0, +bias.
    const img = new Array(9).fill(50);
    const zero: Kernel = [
      [-1, -1, -1],
      [-1, 8, -1],
      [-1, -1, -1],
    ];
    const out = applyKernel(img, 3, 3, zero, 1, 128);
    for (const v of out) expect(v).toBeCloseTo(128, 6);
  });

  it("divisor par défaut = somme du noyau", () => {
    const img = new Array(9).fill(4);
    const gauss: Kernel = [
      [1, 2, 1],
      [2, 4, 2],
      [1, 2, 1],
    ];
    const out = applyKernel(img, 3, 3, gauss); // divisor implicite = 16
    for (const v of out) expect(v).toBeCloseTo(4, 6);
  });

  it("divisor par défaut = 1 quand la somme est nulle", () => {
    const img = new Array(9).fill(10);
    const zero: Kernel = [
      [-1, -1, -1],
      [-1, 8, -1],
      [-1, -1, -1],
    ];
    const out = applyKernel(img, 3, 3, zero); // somme 0 -> divisor 1
    for (const v of out) expect(v).toBeCloseTo(0, 6);
  });
});

describe("applyKernel — Sharpen sur centre connu", () => {
  it("rehausse le pixel central d'une image uniforme avec pic", () => {
    // Image 3×3 uniforme à 10 sauf centre à 20.
    const img = [10, 10, 10, 10, 20, 10, 10, 10, 10];
    const sharpen: Kernel = [
      [0, -1, 0],
      [-1, 5, -1],
      [0, -1, 0],
    ];
    const out = applyKernel(img, 3, 3, sharpen, 1, 0);
    // Centre : 5*20 - (10+10+10+10) = 100 - 40 = 60.
    expect(out[4]).toBeCloseTo(60, 6);
  });
});

describe("applyKernel — noyau non carré (1×3 horizontal)", () => {
  it("gère un noyau rectangulaire impair", () => {
    // Sobel-like horizontal simple sur une ligne.
    const img = [1, 2, 3, 4]; // 4×1
    const k: Kernel = [[-1, 0, 1]]; // 1 ligne, 3 colonnes
    const out = applyKernel(img, 4, 1, k, 1, 0);
    // x=0: voisins (-1)*clamp(-1)=1, 0*1, 1*2  -> -1+2 = 1
    expect(out[0]).toBeCloseTo(2 - 1, 6); // 1
    // x=1: -1*1 + 0*2 + 1*3 = 2
    expect(out[1]).toBeCloseTo(2, 6);
    // x=2: -1*2 + 0*3 + 1*4 = 2
    expect(out[2]).toBeCloseTo(2, 6);
    // x=3: -1*3 + 0*4 + 1*clamp(4)=4 -> 1
    expect(out[3]).toBeCloseTo(1, 6);
  });
});

describe("applyKernel — erreurs (cas dégénérés)", () => {
  it("rejette des dimensions non entières ou ≤ 0", () => {
    expect(() => applyKernel([1], 0, 1, IDENTITY)).toThrow(/Dimensions image/);
    expect(() => applyKernel([1], 1.5, 1, IDENTITY)).toThrow(
      /Dimensions image/
    );
    expect(() => applyKernel([1], 1, -1, IDENTITY)).toThrow(/Dimensions image/);
  });

  it("rejette une longueur de pixels incohérente", () => {
    expect(() => applyKernel([1, 2, 3], 2, 2, IDENTITY)).toThrow(
      /Longueur pixels/
    );
  });

  it("rejette un noyau invalide", () => {
    expect(() => applyKernel([1], 1, 1, [[1, 1]] as Kernel)).toThrow();
  });

  it("rejette un diviseur nul explicite", () => {
    expect(() => applyKernel([1], 1, 1, IDENTITY, 0)).toThrow(/Diviseur nul/);
  });
});

describe("CONVOLUTION_KERNELS — catalogue", () => {
  const expectedNames = [
    "Sharpen",
    "Blur",
    "EdgeDetect",
    "Emboss",
    "Unsharp",
    "MedianApprox",
  ];

  it("contient exactement les filtres attendus", () => {
    expect(CONVOLUTION_KERNELS.map(k => k.name)).toEqual(expectedNames);
  });

  it("chaque filtre a un noyau valide et un label", () => {
    for (const f of CONVOLUTION_KERNELS) {
      expect(validateKernel(f.kernel)).toBeNull();
      expect(typeof f.label).toBe("string");
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it("Blur préserve la luminosité (somme/divisor = 1)", () => {
    const blur = CONVOLUTION_KERNELS.find(k => k.name === "Blur")!;
    expect(kernelSum(blur.kernel) / (blur.divisor ?? 1)).toBeCloseTo(1, 6);
  });

  it("EdgeDetect et Emboss n'ont pas une somme positive de luminosité", () => {
    const edge = CONVOLUTION_KERNELS.find(k => k.name === "EdgeDetect")!;
    expect(kernelSum(edge.kernel)).toBe(0);
    const emboss = CONVOLUTION_KERNELS.find(k => k.name === "Emboss")!;
    expect(kernelSum(emboss.kernel)).toBe(1); // emboss directionnel non nul mais ~neutre
  });

  it("MedianApprox = moyenne 3×3 (somme 9, divisor 9)", () => {
    const med = CONVOLUTION_KERNELS.find(k => k.name === "MedianApprox")!;
    expect(kernelSum(med.kernel)).toBe(9);
    expect(med.divisor).toBe(9);
  });
});

describe("applyNamedFilter", () => {
  it("applique un filtre du catalogue par son nom", () => {
    const img = new Array(9).fill(12);
    const out = applyNamedFilter(img, 3, 3, "Blur");
    for (const v of out) expect(v).toBeCloseTo(12, 6); // flou neutre sur uniforme
  });

  it("Emboss applique le bias 128 sur image uniforme", () => {
    const img = new Array(9).fill(40);
    const out = applyNamedFilter(img, 3, 3, "Emboss");
    // somme noyau emboss = 1 -> 40*1 + 128 = 168 sur image uniforme.
    for (const v of out) expect(v).toBeCloseTo(168, 6);
  });

  it("rejette un nom de filtre inconnu", () => {
    expect(() => applyNamedFilter([1], 1, 1, "Inconnu")).toThrow(
      /Filtre de convolution inconnu/
    );
  });
});
