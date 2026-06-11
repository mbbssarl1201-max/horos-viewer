import { describe, it, expect } from "vitest";
import {
  nextRotation,
  toggleFlip,
  scaleForActualSize,
  scaleToFit,
  composeTransform,
  ZOOM_PRESETS,
  type FlipState,
  type ViewportTransform,
} from "./viewportTransforms";

describe("ZOOM_PRESETS", () => {
  it("contient les presets attendus dans l'ordre", () => {
    expect(ZOOM_PRESETS).toEqual([25, 50, 100, 200, 300]);
  });
  it("inclut 100 (taille native)", () => {
    expect(ZOOM_PRESETS).toContain(100);
  });
});

describe("nextRotation", () => {
  it("ajoute un delta simple", () => {
    expect(nextRotation(0, 90)).toBe(90);
    expect(nextRotation(90, 90)).toBe(180);
    expect(nextRotation(270, 90)).toBe(0);
  });
  it("normalise dans [0, 360[", () => {
    expect(nextRotation(350, 20)).toBe(10);
    expect(nextRotation(0, 360)).toBe(0);
    expect(nextRotation(0, 720)).toBe(0);
  });
  it("gère les deltas négatifs (antihoraire)", () => {
    expect(nextRotation(0, -90)).toBe(270);
    expect(nextRotation(45, -90)).toBe(315);
    expect(nextRotation(0, -360)).toBe(0);
    expect(nextRotation(0, -450)).toBe(270);
  });
  it("normalise un angle de départ déjà hors borne", () => {
    expect(nextRotation(450, 0)).toBe(90);
    expect(nextRotation(-90, 0)).toBe(270);
  });
  it("supporte les deltas fractionnaires", () => {
    expect(nextRotation(0, 0.5)).toBeCloseTo(0.5, 10);
    expect(nextRotation(359.5, 1)).toBeCloseTo(0.5, 10);
  });
  it("traite les entrées non finies comme 0", () => {
    expect(nextRotation(NaN, 90)).toBe(90);
    expect(nextRotation(90, NaN)).toBe(90);
    expect(nextRotation(Infinity, 0)).toBe(0);
    expect(nextRotation(0, Infinity)).toBe(0);
    expect(nextRotation(NaN, NaN)).toBe(0);
  });
});

describe("toggleFlip", () => {
  it("bascule l'axe horizontal sans toucher au vertical", () => {
    const s: FlipState = { h: false, v: false };
    expect(toggleFlip(s, "h")).toEqual({ h: true, v: false });
  });
  it("bascule l'axe vertical sans toucher à l'horizontal", () => {
    const s: FlipState = { h: true, v: false };
    expect(toggleFlip(s, "v")).toEqual({ h: true, v: true });
  });
  it("rebascule revient à l'état initial", () => {
    const s: FlipState = { h: false, v: false };
    expect(toggleFlip(toggleFlip(s, "h"), "h")).toEqual(s);
  });
  it("n'altère JAMAIS l'objet d'entrée (immuable)", () => {
    const s: FlipState = { h: false, v: false };
    const out = toggleFlip(s, "h");
    expect(s).toEqual({ h: false, v: false });
    expect(out).not.toBe(s);
  });
});

describe("scaleForActualSize", () => {
  it("calcule pixels écran par pixel image au 1:1", () => {
    // 96 DPI, 1 mm/pixel → 96/25.4 ≈ 3.7795 px écran / px image
    expect(scaleForActualSize(1, 96)).toBeCloseTo(96 / 25.4, 10);
  });
  it("est proportionnel à l'espacement pixel", () => {
    const a = scaleForActualSize(0.5, 96)!;
    const b = scaleForActualSize(1, 96)!;
    expect(b).toBeCloseTo(a * 2, 10);
  });
  it("est proportionnel au DPI", () => {
    const a = scaleForActualSize(1, 96)!;
    const b = scaleForActualSize(1, 192)!;
    expect(b).toBeCloseTo(a * 2, 10);
  });
  it("renvoie null sur entrées invalides", () => {
    expect(scaleForActualSize(0, 96)).toBeNull();
    expect(scaleForActualSize(-1, 96)).toBeNull();
    expect(scaleForActualSize(1, 0)).toBeNull();
    expect(scaleForActualSize(1, -10)).toBeNull();
    expect(scaleForActualSize(NaN, 96)).toBeNull();
    expect(scaleForActualSize(1, Infinity)).toBeNull();
  });
});

describe("scaleToFit", () => {
  it("prend la plus petite échelle (contain) — limité par la largeur", () => {
    // image 200x100 dans 100x100 → min(0.5, 1) = 0.5
    expect(scaleToFit(200, 100, 100, 100)).toBe(0.5);
  });
  it("limité par la hauteur", () => {
    // image 100x200 dans 100x100 → min(1, 0.5) = 0.5
    expect(scaleToFit(100, 200, 100, 100)).toBe(0.5);
  });
  it("agrandit une petite image (facteur > 1)", () => {
    // image 50x50 dans 100x100 → 2
    expect(scaleToFit(50, 50, 100, 100)).toBe(2);
  });
  it("facteur 1 quand image = fenêtre", () => {
    expect(scaleToFit(100, 100, 100, 100)).toBe(1);
  });
  it("gère des ratios non carrés", () => {
    // image 400x300 dans 800x300 → min(2, 1) = 1
    expect(scaleToFit(400, 300, 800, 300)).toBe(1);
  });
  it("renvoie null sur dimensions invalides", () => {
    expect(scaleToFit(0, 100, 100, 100)).toBeNull();
    expect(scaleToFit(100, 0, 100, 100)).toBeNull();
    expect(scaleToFit(100, 100, 0, 100)).toBeNull();
    expect(scaleToFit(100, 100, 100, 0)).toBeNull();
    expect(scaleToFit(-1, 100, 100, 100)).toBeNull();
    expect(scaleToFit(NaN, 100, 100, 100)).toBeNull();
    expect(scaleToFit(100, 100, Infinity, 100)).toBeNull();
  });
});

describe("composeTransform", () => {
  const base: ViewportTransform = {
    rotation: 0,
    flipH: false,
    flipV: false,
    zoom: 1,
  };

  it("identité pour la transformation neutre", () => {
    const m = composeTransform(base);
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.c).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it("échelle uniforme par le zoom", () => {
    const m = composeTransform({ ...base, zoom: 2 });
    expect(m.a).toBeCloseTo(2, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.c).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(2, 12);
  });

  it("retournement horizontal inverse le signe de sx", () => {
    const m = composeTransform({ ...base, flipH: true });
    expect(m.a).toBeCloseTo(-1, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it("retournement vertical inverse le signe de sy", () => {
    const m = composeTransform({ ...base, flipV: true });
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.d).toBeCloseTo(-1, 12);
  });

  it("rotation 90° horaire", () => {
    const m = composeTransform({ ...base, rotation: 90 });
    // R(90) = [[0,-1],[1,0]] → a=0, b=1, c=-1, d=0
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(1, 12);
    expect(m.c).toBeCloseTo(-1, 12);
    expect(m.d).toBeCloseTo(0, 12);
  });

  it("rotation 180°", () => {
    const m = composeTransform({ ...base, rotation: 180 });
    expect(m.a).toBeCloseTo(-1, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.c).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(-1, 12);
  });

  it("rotation 270°", () => {
    const m = composeTransform({ ...base, rotation: 270 });
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(-1, 12);
    expect(m.c).toBeCloseTo(1, 12);
    expect(m.d).toBeCloseTo(0, 12);
  });

  it("combine zoom + rotation 90°", () => {
    const m = composeTransform({ ...base, rotation: 90, zoom: 3 });
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(3, 12);
    expect(m.c).toBeCloseTo(-3, 12);
    expect(m.d).toBeCloseTo(0, 12);
  });

  it("combine flip horizontal + rotation 90°", () => {
    const m = composeTransform({ ...base, rotation: 90, flipH: true });
    // sx=-1, sy=1, R(90)=[[0,-1],[1,0]] → a=0, b=-1, c=-1, d=0
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(-1, 12);
    expect(m.c).toBeCloseTo(-1, 12);
    expect(m.d).toBeCloseTo(0, 12);
  });

  it("préserve le déterminant en valeur absolue = zoom²", () => {
    const m = composeTransform({ ...base, rotation: 37, zoom: 2 });
    const det = m.a * m.d - m.b * m.c;
    expect(Math.abs(det)).toBeCloseTo(4, 10);
  });

  it("un flip inverse le signe du déterminant", () => {
    const noFlip = composeTransform({ ...base, rotation: 37 });
    const withFlip = composeTransform({ ...base, rotation: 37, flipH: true });
    const detNo = noFlip.a * noFlip.d - noFlip.b * noFlip.c;
    const detYes = withFlip.a * withFlip.d - withFlip.b * withFlip.c;
    expect(detNo).toBeCloseTo(1, 10);
    expect(detYes).toBeCloseTo(-1, 10);
  });

  it("normalise une rotation hors borne", () => {
    const a = composeTransform({ ...base, rotation: 450 });
    const b = composeTransform({ ...base, rotation: 90 });
    expect(a).toEqual(b);
  });

  it("dégénéré : zoom non fini → 1", () => {
    const m = composeTransform({ ...base, zoom: NaN });
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it("dégénéré : zoom négatif borné à 0", () => {
    const m = composeTransform({ ...base, zoom: -5 });
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.c).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(0, 12);
  });

  it("dégénéré : rotation non finie → 0", () => {
    const m = composeTransform({ ...base, rotation: Infinity });
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it("est déterministe (mêmes entrées → mêmes sorties)", () => {
    const t: ViewportTransform = {
      rotation: 123,
      flipH: true,
      flipV: true,
      zoom: 1.5,
    };
    expect(composeTransform(t)).toEqual(composeTransform(t));
  });
});
