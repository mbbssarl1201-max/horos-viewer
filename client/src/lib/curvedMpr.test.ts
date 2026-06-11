import { describe, it, expect } from "vitest";
import {
  normalize,
  cross,
  polylineLength,
  resampleCenterline,
  buildCprImage,
  cprImageToRgba,
  type Vec3,
} from "./curvedMpr";

describe("normalize", () => {
  it("normalise un vecteur", () => {
    expect(normalize([3, 0, 0])).toEqual([1, 0, 0]);
  });
  it("vecteur nul → 0", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("cross", () => {
  it("x × y = z", () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });
});

describe("polylineLength", () => {
  it("somme des segments", () => {
    expect(
      polylineLength([
        [0, 0, 0],
        [3, 0, 0],
        [3, 4, 0],
      ])
    ).toBe(7);
  });
  it("0/1 point → 0", () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([[1, 2, 3]])).toBe(0);
  });
});

describe("resampleCenterline", () => {
  it("échantillonne à pas régulier le long d'une ligne droite", () => {
    const s = resampleCenterline(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      2
    );
    // 0,2,4,6,8,10 → 6 échantillons
    expect(s.length).toBe(6);
    expect(s[0].position).toEqual([0, 0, 0]);
    expect(s[5].position[0]).toBeCloseTo(10, 6);
    // tangente = +x
    expect(s[0].tangent).toEqual([1, 0, 0]);
    expect(s[3].arcLength).toBeCloseTo(6, 6);
  });

  it("suit un coude (L)", () => {
    const s = resampleCenterline(
      [
        [0, 0, 0],
        [4, 0, 0],
        [4, 4, 0],
      ],
      1
    );
    // longueur 8 → 9 échantillons (0..8)
    expect(s.length).toBe(9);
    // au-delà du coude la tangente devient +y
    expect(s[8].tangent).toEqual([0, 1, 0]);
    expect(s[8].position[1]).toBeCloseTo(4, 6);
  });

  it("entrées invalides → vide", () => {
    expect(resampleCenterline([[0, 0, 0]], 1)).toEqual([]);
    expect(
      resampleCenterline(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        0
      )
    ).toEqual([]);
    expect(
      resampleCenterline(
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        1
      )
    ).toEqual([]);
  });
});

describe("buildCprImage", () => {
  // Petit volume 10×10×3, gradient connu sur x : valeur = x (HU).
  const nx = 10,
    ny = 10,
    nz = 3;
  const scalars = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) scalars[x + y * nx + z * nx * ny] = x;
  const dims: Vec3 = [nx, ny, nz];
  const origin: Vec3 = [0, 0, 0];
  const spacing: Vec3 = [1, 1, 1];

  it("échantillonne le long d'une courbe horizontale (axe x)", () => {
    // centerline au milieu en y/z, de x=1 à x=8, plan axial (normale z).
    const img = buildCprImage(
      scalars,
      dims,
      origin,
      spacing,
      [
        [1, 5, 1],
        [8, 5, 1],
      ],
      { stepMm: 1, halfWidthMm: 2, perpStepMm: 1, planeNormal: [0, 0, 1] }
    );
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBe(5); // 2*2+1
    // ligne centrale (y = halfRows = 2) : valeur ≈ x croissant.
    const yCenter = 2;
    const left = img.data[0 + yCenter * img.width];
    const right = img.data[img.width - 1 + yCenter * img.width];
    expect(left).toBeCloseTo(1, 5);
    expect(right).toBeCloseTo(8, 5);
  });

  it("la perpendiculaire d'une courbe en x est en y (valeur constante en x)", () => {
    // Comme la valeur ne dépend que de x, toute la colonne perpendiculaire (qui
    // varie en y) doit avoir ~la même valeur HU à une abscisse donnée.
    const img = buildCprImage(
      scalars,
      dims,
      origin,
      spacing,
      [
        [1, 5, 1],
        [8, 5, 1],
      ],
      { stepMm: 1, halfWidthMm: 2, perpStepMm: 1 }
    );
    const colX = 2;
    const colVals: number[] = [];
    for (let y = 0; y < img.height; y++)
      colVals.push(img.data[colX + y * img.width]);
    // toutes proches de la valeur centrale
    const center = colVals[2];
    for (const v of colVals) expect(v).toBeCloseTo(center, 5);
  });

  it("entrées invalides → image vide", () => {
    expect(
      buildCprImage(scalars, dims, origin, spacing, [[0, 0, 0]]).width
    ).toBe(0);
    expect(buildCprImage(scalars, dims, origin, spacing, []).data.length).toBe(
      0
    );
  });
});

describe("cprImageToRgba", () => {
  it("convertit en RGBA gris via fenêtre", () => {
    const img = {
      width: 2,
      height: 1,
      data: new Float32Array([0, 100]),
    };
    // WC 50, WW 100 → 0 → 0, 100 → 255
    const rgba = cprImageToRgba(img, 50, 100);
    expect(rgba.length).toBe(2 * 1 * 4);
    expect(rgba[0]).toBe(0); // R du pixel 0
    expect(rgba[3]).toBe(255); // alpha
    expect(rgba[4]).toBe(255); // R du pixel 1
    expect(rgba[7]).toBe(255); // alpha
  });
});
