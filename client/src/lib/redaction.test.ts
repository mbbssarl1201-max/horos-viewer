import { describe, it, expect } from "vitest";
import {
  normalizeRect,
  isNegligibleRect,
  rectToPixels,
  applyRedactions,
  type RedactionContext2D,
  type RedactionRect,
} from "./redaction";

describe("normalizeRect", () => {
  it("convertit un glissé haut-gauche → bas-droite en fractions", () => {
    const r = normalizeRect(20, 10, 60, 50, 100, 100);
    expect(r).toEqual({ x: 0.2, y: 0.1, w: 0.4, h: 0.4 });
  });

  it("gère un glissé inversé (bas-droite → haut-gauche)", () => {
    const r = normalizeRect(60, 50, 20, 10, 100, 100);
    expect(r).toEqual({ x: 0.2, y: 0.1, w: 0.4, h: 0.4 });
  });

  it("borne les coordonnées hors du conteneur", () => {
    const r = normalizeRect(-50, -50, 200, 200, 100, 100);
    expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("renvoie un rectangle nul pour un conteneur dégénéré", () => {
    expect(normalizeRect(0, 0, 10, 10, 0, 100)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });

  it("gère des dimensions de conteneur non carrées", () => {
    const r = normalizeRect(100, 30, 300, 90, 400, 300);
    expect(r.x).toBeCloseTo(0.25);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.h).toBeCloseTo(0.2);
  });
});

describe("isNegligibleRect", () => {
  it("rejette un clic quasi sans glissé", () => {
    expect(isNegligibleRect({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 })).toBe(true);
  });
  it("accepte un rectangle de taille utile", () => {
    expect(isNegligibleRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(false);
  });
});

describe("rectToPixels", () => {
  it("convertit en pixels entiers couvrant au moins la zone", () => {
    const p = rectToPixels({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, 200, 200);
    expect(p).toEqual({ x: 50, y: 100, w: 50, h: 50 });
  });

  it("arrondit pour ne jamais sous-couvrir (PHI ne doit pas dépasser)", () => {
    // 0.333 * 99 = 32.96 → floor 32 ; bord = 0.999 → ceil 99 ; w = 67.
    const p = rectToPixels({ x: 0.333, y: 0, w: 0.666, h: 1 }, 99, 99);
    expect(p.x).toBe(32);
    expect(p.x + p.w).toBeGreaterThanOrEqual(Math.round(0.999 * 99) - 1);
  });

  it("borne à l'intérieur du canvas", () => {
    const p = rectToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100);
    expect(p.x + p.w).toBeLessThanOrEqual(100);
    expect(p.y + p.h).toBeLessThanOrEqual(100);
  });
});

describe("applyRedactions", () => {
  // Faux contexte 2D : enregistre les fillRect et impose le noir opaque.
  function fakeCtx() {
    const calls: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
    }> = [];
    const ctx: RedactionContext2D = {
      fillStyle: "white",
      fillRect(x, y, w, h) {
        calls.push({ x, y, w, h, fill: this.fillStyle as string });
      },
    };
    return { ctx, calls };
  }

  it("peint chaque rectangle en noir opaque, aux bons pixels", () => {
    const { ctx, calls } = fakeCtx();
    const rects: RedactionRect[] = [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];
    const painted = applyRedactions(ctx, rects, 100, 100);
    expect(painted).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.fill === "#000000")).toBe(true);
    expect(calls[0]).toMatchObject({ x: 0, y: 0, w: 50, h: 50 });
    expect(calls[1]).toMatchObject({ x: 50, y: 50, w: 50, h: 50 });
  });

  it("ignore les rectangles de surface nulle", () => {
    const { ctx, calls } = fakeCtx();
    const painted = applyRedactions(
      ctx,
      [{ x: 0.5, y: 0.5, w: 0, h: 0 }],
      100,
      100
    );
    expect(painted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("restaure le fillStyle initial après peinture", () => {
    const { ctx } = fakeCtx();
    ctx.fillStyle = "red";
    applyRedactions(ctx, [{ x: 0, y: 0, w: 1, h: 1 }], 10, 10);
    expect(ctx.fillStyle).toBe("red");
  });

  it("ne peint rien sur un canvas dégénéré", () => {
    const { ctx, calls } = fakeCtx();
    expect(applyRedactions(ctx, [{ x: 0, y: 0, w: 1, h: 1 }], 0, 0)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
