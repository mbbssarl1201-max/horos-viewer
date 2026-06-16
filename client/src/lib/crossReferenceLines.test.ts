import { describe, it, expect } from "vitest";
import {
  dot,
  cross,
  sub,
  add,
  scale,
  norm,
  normalize,
  planeFromDicom,
  patientToPixel,
  planeIntersectionRay,
  intersectionLine,
  type ImagePlane,
  type Vec3,
} from "./crossReferenceLines";

// ── Helpers de plans de référence (repère patient LPS, mm) ──────────────────
// Axial : rowDir=+X, colDir=+Y, normale=+Z (coupe à z constant).
function axialPlane(z = 0, rows = 100, cols = 100, sp = 1): ImagePlane {
  return planeFromDicom({
    iop: [1, 0, 0, 0, 1, 0],
    ipp: [0, 0, z],
    rows,
    cols,
    spacing: [sp, sp],
  })!;
}

// Sagittal : rowDir=+Y, colDir=+Z, normale=+X (coupe à x constant).
function sagittalPlane(x = 0, rows = 100, cols = 100, sp = 1): ImagePlane {
  return planeFromDicom({
    iop: [0, 1, 0, 0, 0, 1],
    ipp: [x, 0, 0],
    rows,
    cols,
    spacing: [sp, sp],
  })!;
}

// Coronal : rowDir=+X, colDir=+Z, normale=−Y (ici normale ±Y, coupe à y constant).
function coronalPlane(y = 0, rows = 100, cols = 100, sp = 1): ImagePlane {
  return planeFromDicom({
    iop: [1, 0, 0, 0, 0, 1],
    ipp: [0, y, 0],
    rows,
    cols,
    spacing: [sp, sp],
  })!;
}

describe("primitives vectorielles", () => {
  it("dot", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  it("cross x×y=z", () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });
  it("cross anti-commutatif", () => {
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
  });
  it("sub/add/scale", () => {
    expect(sub([3, 3, 3], [1, 2, 3])).toEqual([2, 1, 0]);
    expect(add([1, 1, 1], [2, 3, 4])).toEqual([3, 4, 5]);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
  });
  it("norm", () => {
    expect(norm([3, 4, 0])).toBe(5);
  });
  it("normalize", () => {
    expect(normalize([0, 0, 5])).toEqual([0, 0, 1]);
  });
  it("normalize vecteur nul → 0", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("planeFromDicom", () => {
  it("axial : normale = +Z", () => {
    const p = axialPlane();
    expect(p.normal).toEqual([0, 0, 1]);
    expect(p.rowDir).toEqual([1, 0, 0]);
    expect(p.colDir).toEqual([0, 1, 0]);
  });

  it("sagittal : normale = +X", () => {
    const p = sagittalPlane();
    expect(p.normal).toEqual([1, 0, 0]);
  });

  it("re-normalise des IOP non unitaires", () => {
    const p = planeFromDicom({
      iop: [2, 0, 0, 0, 3, 0],
      ipp: [0, 0, 0],
      rows: 10,
      cols: 10,
      spacing: [1, 1],
    })!;
    expect(p.rowDir).toEqual([1, 0, 0]);
    expect(p.colDir).toEqual([0, 1, 0]);
    expect(norm(p.normal)).toBeCloseTo(1, 12);
  });

  it("accepte des chaînes (tags DICOM bruts)", () => {
    const p = planeFromDicom({
      iop: ["1", "0", "0", "0", "1", "0"],
      ipp: ["0", "0", "5"],
      rows: 10,
      cols: 10,
      spacing: ["2", "2"],
    } as never)!;
    expect(p).not.toBeNull();
    expect(p.origin).toEqual([0, 0, 5]);
    expect(p.rowSpacing).toBe(2);
  });

  it("floor sur rows/cols non entiers", () => {
    const p = planeFromDicom({
      iop: [1, 0, 0, 0, 1, 0],
      ipp: [0, 0, 0],
      rows: 99.9,
      cols: 50.4,
      spacing: [1, 1],
    })!;
    expect(p.rows).toBe(99);
    expect(p.cols).toBe(50);
  });

  // ── Cas dégénérés → null ──────────────────────────────────────────────
  it("IOP trop court → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0],
        ipp: [0, 0, 0],
        rows: 10,
        cols: 10,
        spacing: [1, 1],
      })
    ).toBeNull();
  });
  it("IPP trop court → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0, 0, 1, 0],
        ipp: [0, 0],
        rows: 10,
        cols: 10,
        spacing: [1, 1],
      })
    ).toBeNull();
  });
  it("IOP non numérique → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0, 0, "abc", 0],
        ipp: [0, 0, 0],
        rows: 10,
        cols: 10,
        spacing: [1, 1],
      } as never)
    ).toBeNull();
  });
  it("spacing ≤ 0 → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0, 0, 1, 0],
        ipp: [0, 0, 0],
        rows: 10,
        cols: 10,
        spacing: [0, 1],
      })
    ).toBeNull();
  });
  it("rows ≤ 0 → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0, 0, 1, 0],
        ipp: [0, 0, 0],
        rows: 0,
        cols: 10,
        spacing: [1, 1],
      })
    ).toBeNull();
  });
  it("rowDir ∥ colDir (plan dégénéré) → null", () => {
    expect(
      planeFromDicom({
        iop: [1, 0, 0, 1, 0, 0],
        ipp: [0, 0, 0],
        rows: 10,
        cols: 10,
        spacing: [1, 1],
      })
    ).toBeNull();
  });
  it("rowDir nul → null", () => {
    expect(
      planeFromDicom({
        iop: [0, 0, 0, 0, 1, 0],
        ipp: [0, 0, 0],
        rows: 10,
        cols: 10,
        spacing: [1, 1],
      })
    ).toBeNull();
  });
});

describe("patientToPixel", () => {
  it("origine du plan → (0,0)", () => {
    const p = axialPlane(0, 100, 100, 1);
    expect(patientToPixel(p, p.origin)).toEqual([0, 0]);
  });
  it("axial : +X → +col, +Y → +row, espacement appliqué", () => {
    const p = axialPlane(0, 100, 100, 2); // spacing 2 mm
    // 10 mm en X → 5 colonnes ; 6 mm en Y → 3 lignes.
    expect(patientToPixel(p, [10, 6, 0])).toEqual([5, 3]);
  });
  it("composante hors plan ignorée (projection)", () => {
    const p = axialPlane(0, 100, 100, 1);
    // décalage en Z (hors plan) n'affecte pas (col,row).
    expect(patientToPixel(p, [4, 7, 50])).toEqual([4, 7]);
  });
});

describe("planeIntersectionRay", () => {
  it("axial ∩ sagittal : direction ‖ Y", () => {
    const r = planeIntersectionRay(axialPlane(0), sagittalPlane(0))!;
    expect(r).not.toBeNull();
    const d = normalize(r.direction as Vec3);
    // direction colinéaire à ±Y
    expect(Math.abs(d[0])).toBeCloseTo(0, 12);
    expect(Math.abs(d[2])).toBeCloseTo(0, 12);
    expect(Math.abs(d[1])).toBeCloseTo(1, 12);
  });

  it("le point de la droite vérifie les deux équations de plan", () => {
    const src = axialPlane(7); // z = 7
    const tgt = sagittalPlane(3); // x = 3
    const r = planeIntersectionRay(src, tgt)!;
    // appartenance au plan source : normal·(point − origin) = 0
    expect(dot(src.normal, sub(r.point, src.origin))).toBeCloseTo(0, 9);
    expect(dot(tgt.normal, sub(r.point, tgt.origin))).toBeCloseTo(0, 9);
  });

  it("plans parallèles → null", () => {
    expect(planeIntersectionRay(axialPlane(0), axialPlane(50))).toBeNull();
  });
  it("plan identique → null (normales colinéaires)", () => {
    expect(planeIntersectionRay(axialPlane(0), axialPlane(0))).toBeNull();
  });
});

describe("intersectionLine — cas orthogonaux nominaux", () => {
  it("axial (z=20) tracé sur sagittal : ligne horizontale à row = z/spacing", () => {
    // Sagittal x=0, rows/cols 100, spacing 1. Sa colDir=+Z, donc row ∝ Z.
    // L'axial est à z=20 → la trace est la droite Z=20 dans le plan sagittal,
    // soit row = 20, col variant sur toute la largeur (Y de 0 à 100).
    const seg = intersectionLine(
      axialPlane(20),
      sagittalPlane(0, 100, 100, 1)
    )!;
    expect(seg).not.toBeNull();
    // Les deux extrémités à row = 20.
    expect(seg.start[1]).toBeCloseTo(20, 9);
    expect(seg.end[1]).toBeCloseTo(20, 9);
    // Col couvre tout le cadre [0, 100].
    const cols = [seg.start[0], seg.end[0]].sort((a, b) => a - b);
    expect(cols[0]).toBeCloseTo(0, 9);
    expect(cols[1]).toBeCloseTo(100, 9);
  });

  it("sagittal (x=30) tracé sur axial : ligne verticale à col = x/spacing", () => {
    // Axial rowDir=+X → col ∝ X. Le sagittal à x=30 → col = 30, row sur [0,100].
    const seg = intersectionLine(
      sagittalPlane(30),
      axialPlane(0, 100, 100, 1)
    )!;
    expect(seg.start[0]).toBeCloseTo(30, 9);
    expect(seg.end[0]).toBeCloseTo(30, 9);
    const rows = [seg.start[1], seg.end[1]].sort((a, b) => a - b);
    expect(rows[0]).toBeCloseTo(0, 9);
    expect(rows[1]).toBeCloseTo(100, 9);
  });

  it("espacement non unitaire : row = z / rowSpacing", () => {
    // Sagittal spacing 2 mm. Axial z=20 → row = 20/2 = 10.
    const seg = intersectionLine(
      axialPlane(20),
      sagittalPlane(0, 100, 100, 2)
    )!;
    expect(seg.start[1]).toBeCloseTo(10, 9);
    expect(seg.end[1]).toBeCloseTo(10, 9);
  });

  it("axial sur coronal : ligne horizontale (row ∝ Z)", () => {
    const seg = intersectionLine(axialPlane(40), coronalPlane(0, 100, 100, 1))!;
    expect(seg.start[1]).toBeCloseTo(40, 9);
    expect(seg.end[1]).toBeCloseTo(40, 9);
  });
});

describe("intersectionLine — bords & dégénérés", () => {
  it("plans parallèles → null", () => {
    expect(intersectionLine(axialPlane(0), axialPlane(10))).toBeNull();
  });

  it("intersection hors cadre cible → null", () => {
    // Axial z=500 mais sagittal ne couvre que rows=100 (z ∈ [0,100]).
    expect(
      intersectionLine(axialPlane(500), sagittalPlane(0, 100, 100, 1))
    ).toBeNull();
  });

  it("z négatif (avant le cadre) → null", () => {
    expect(
      intersectionLine(axialPlane(-5), sagittalPlane(0, 100, 100, 1))
    ).toBeNull();
  });

  it("z exactement au bord (z=0) reste tracé", () => {
    const seg = intersectionLine(axialPlane(0), sagittalPlane(0, 100, 100, 1))!;
    expect(seg).not.toBeNull();
    expect(seg.start[1]).toBeCloseTo(0, 9);
    expect(seg.end[1]).toBeCloseTo(0, 9);
  });

  it("z au bord supérieur (z=100) reste tracé", () => {
    const seg = intersectionLine(
      axialPlane(100),
      sagittalPlane(0, 100, 100, 1)
    )!;
    expect(seg.start[1]).toBeCloseTo(100, 9);
  });

  it("sagittal ∩ coronal projeté sur l'axial : direction Z hors-plan → ligne dans la cible", () => {
    // L'intersection sagittal(x=10) ∩ coronal(y=10) est portée par Z. La cible
    // étant le COURONAL (colDir=+Z), cette direction est DANS le plan cible : on
    // obtient une vraie ligne verticale à col = x = 10 (rowDir coronal = +X).
    const seg = intersectionLine(
      sagittalPlane(10),
      coronalPlane(10, 100, 100, 1)
    )!;
    expect(seg).not.toBeNull();
    expect(seg.start[0]).toBeCloseTo(10, 9);
    expect(seg.end[0]).toBeCloseTo(10, 9);
    expect(seg.start).not.toEqual(seg.end);
  });

  it("retour symétrique : start≠end pour une vraie ligne", () => {
    const seg = intersectionLine(
      axialPlane(50),
      sagittalPlane(0, 100, 100, 1)
    )!;
    expect(seg.start).not.toEqual(seg.end);
  });
});

describe("intersectionLine — robustesse géométrique", () => {
  it("plan oblique : la trace reste dans le cadre cible", () => {
    // Source obliquée à 45° autour de Y : rowDir=(cos,0,sin)... construisons-la.
    const c = Math.SQRT1_2;
    const oblique = planeFromDicom({
      iop: [c, 0, c, 0, 1, 0], // rowDir oblique XZ, colDir = Y
      ipp: [0, 0, 0],
      rows: 100,
      cols: 100,
      spacing: [1, 1],
    })!;
    const seg = intersectionLine(oblique, sagittalPlane(50, 100, 100, 1));
    if (seg) {
      for (const pt of [seg.start, seg.end]) {
        expect(pt[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(pt[0]).toBeLessThanOrEqual(100 + 1e-6);
        expect(pt[1]).toBeGreaterThanOrEqual(-1e-6);
        expect(pt[1]).toBeLessThanOrEqual(100 + 1e-6);
      }
    }
  });

  it("symétrie d'appartenance : extrémités sont sur le plan source", () => {
    const src = axialPlane(25);
    const tgt = sagittalPlane(0, 100, 100, 1);
    const seg = intersectionLine(src, tgt)!;
    // Reconstruire le point patient d'une extrémité du segment cible et vérifier
    // qu'il appartient au plan source (z = 25).
    const reconstruct = (col: number, row: number): Vec3 =>
      add(
        tgt.origin,
        add(
          scale(tgt.rowDir, col * tgt.colSpacing),
          scale(tgt.colDir, row * tgt.rowSpacing)
        )
      );
    const pStart = reconstruct(seg.start[0], seg.start[1]);
    expect(dot(src.normal, sub(pStart, src.origin))).toBeCloseTo(0, 6);
  });
});
