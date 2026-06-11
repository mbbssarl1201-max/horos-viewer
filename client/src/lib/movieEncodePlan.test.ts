import { describe, it, expect } from "vitest";
import {
  MOVIE_FORMATS,
  normalizeFps,
  evenDimension,
  estimateFrames,
  buildEncodePlan,
  type EncodePlan,
} from "./movieEncodePlan";

describe("MOVIE_FORMATS", () => {
  it("expose mp4 et gif", () => {
    expect(MOVIE_FORMATS).toEqual(["mp4", "gif"]);
  });
});

describe("normalizeFps", () => {
  it("conserve une cadence licite", () => {
    expect(normalizeFps(15)).toBe(15);
    expect(normalizeFps(24)).toBe(24);
  });

  it("borne au minimum (>= 1)", () => {
    expect(normalizeFps(0)).toBe(1);
    expect(normalizeFps(-10)).toBe(1);
  });

  it("borne au maximum (<= 60)", () => {
    expect(normalizeFps(120)).toBe(60);
  });

  it("NaN / Infinity → minimum", () => {
    expect(normalizeFps(NaN)).toBe(1);
    expect(normalizeFps(Infinity)).toBe(1);
    expect(normalizeFps(-Infinity)).toBe(1);
  });

  it("conserve les cadences fractionnaires", () => {
    expect(normalizeFps(7.5)).toBe(7.5);
  });
});

describe("evenDimension", () => {
  it("conserve un entier pair", () => {
    expect(evenDimension(512)).toBe(512);
  });

  it("arrondit un impair vers le bas au pair", () => {
    expect(evenDimension(513)).toBe(512);
    expect(evenDimension(3)).toBe(2);
  });

  it("arrondit un flottant vers le pair inférieur", () => {
    expect(evenDimension(511.9)).toBe(510);
    expect(evenDimension(4.7)).toBe(4);
  });

  it("plancher à 2 pour les petites valeurs", () => {
    expect(evenDimension(1)).toBe(2);
    expect(evenDimension(2)).toBe(2);
  });

  it("valeurs dégénérées → 2", () => {
    expect(evenDimension(0)).toBe(2);
    expect(evenDimension(-100)).toBe(2);
    expect(evenDimension(NaN)).toBe(2);
    expect(evenDimension(Infinity)).toBe(2);
  });
});

describe("estimateFrames", () => {
  it("sans plage : renvoie le nombre de coupes", () => {
    expect(estimateFrames(120)).toBe(120);
  });

  it("tronque un nombre de coupes flottant", () => {
    expect(estimateFrames(120.9)).toBe(120);
  });

  it("plage inclusive standard", () => {
    expect(estimateFrames(100, { start: 10, end: 19 })).toBe(10);
    expect(estimateFrames(100, { start: 0, end: 0 })).toBe(1);
  });

  it("plage pleine = toutes les coupes", () => {
    expect(estimateFrames(50, { start: 0, end: 49 })).toBe(50);
  });

  it("plage inversée est remise dans l'ordre", () => {
    expect(estimateFrames(100, { start: 19, end: 10 })).toBe(10);
  });

  it("plage débordante est bornée aux indices valides", () => {
    expect(estimateFrames(10, { start: -5, end: 999 })).toBe(10);
    expect(estimateFrames(10, { start: 5, end: 999 })).toBe(5);
  });

  it("coupes <= 0 → 0", () => {
    expect(estimateFrames(0)).toBe(0);
    expect(estimateFrames(-3)).toBe(0);
    expect(estimateFrames(0, { start: 0, end: 5 })).toBe(0);
  });

  it("coupes non finies → 0", () => {
    expect(estimateFrames(NaN)).toBe(0);
    expect(estimateFrames(Infinity)).toBe(0);
  });

  it("indices flottants sont tronqués", () => {
    expect(estimateFrames(100, { start: 10.9, end: 19.9 })).toBe(10);
  });
});

/** Récupère la valeur de l'argument suivant un flag donné. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildEncodePlan — mp4", () => {
  const plan: EncodePlan = buildEncodePlan({
    frameCount: 60,
    fps: 30,
    format: "mp4",
    width: 512,
    height: 512,
  });

  it("cadence et durée correctes", () => {
    expect(plan.fps).toBe(30);
    expect(plan.duration).toBeCloseTo(2, 10);
  });

  it("entrée image2 numérotée et cadence passées à ffmpeg", () => {
    expect(argAfter(plan.ffmpegArgs, "-framerate")).toBe("30");
    expect(argAfter(plan.ffmpegArgs, "-i")).toBe("frame-%05d.png");
  });

  it("encode en H.264 yuv420p avec CRF", () => {
    expect(argAfter(plan.ffmpegArgs, "-c:v")).toBe("libx264");
    expect(argAfter(plan.ffmpegArgs, "-crf")).toBe("18");
    expect(argAfter(plan.ffmpegArgs, "-vf")).toContain("format=yuv420p");
    expect(argAfter(plan.ffmpegArgs, "-vf")).toContain("scale=512:512");
  });

  it("sortie .mp4 avec faststart", () => {
    expect(plan.ffmpegArgs[plan.ffmpegArgs.length - 1]).toBe("output.mp4");
    expect(argAfter(plan.ffmpegArgs, "-movflags")).toBe("+faststart");
  });

  it("force des dimensions paires", () => {
    const odd = buildEncodePlan({
      frameCount: 10,
      fps: 10,
      format: "mp4",
      width: 513,
      height: 511,
    });
    expect(argAfter(odd.ffmpegArgs, "-vf")).toContain("scale=512:510");
  });
});

describe("buildEncodePlan — gif", () => {
  const plan = buildEncodePlan({
    frameCount: 30,
    fps: 15,
    format: "gif",
    width: 256,
    height: 256,
  });

  it("cadence et durée correctes", () => {
    expect(plan.fps).toBe(15);
    expect(plan.duration).toBeCloseTo(2, 10);
  });

  it("génère une palette (palettegen/paletteuse) et boucle infinie", () => {
    const vf = argAfter(plan.ffmpegArgs, "-vf") ?? "";
    expect(vf).toContain("palettegen");
    expect(vf).toContain("paletteuse");
    expect(vf).toContain("scale=256:256");
    expect(argAfter(plan.ffmpegArgs, "-loop")).toBe("0");
  });

  it("sortie .gif et pas de codec libx264", () => {
    expect(plan.ffmpegArgs[plan.ffmpegArgs.length - 1]).toBe("output.gif");
    expect(plan.ffmpegArgs).not.toContain("libx264");
  });
});

describe("buildEncodePlan — robustesse", () => {
  it("fps dégénéré est borné (durée finie)", () => {
    const plan = buildEncodePlan({
      frameCount: 10,
      fps: 0,
      format: "mp4",
      width: 100,
      height: 100,
    });
    expect(plan.fps).toBe(1);
    expect(plan.duration).toBe(10);
  });

  it("frameCount nul → durée 0", () => {
    const plan = buildEncodePlan({
      frameCount: 0,
      fps: 30,
      format: "mp4",
      width: 100,
      height: 100,
    });
    expect(plan.duration).toBe(0);
  });

  it("frameCount négatif / non fini → 0 image, durée 0", () => {
    expect(
      buildEncodePlan({
        frameCount: -5,
        fps: 30,
        format: "gif",
        width: 100,
        height: 100,
      }).duration
    ).toBe(0);
    expect(
      buildEncodePlan({
        frameCount: NaN,
        fps: 30,
        format: "mp4",
        width: 100,
        height: 100,
      }).duration
    ).toBe(0);
  });

  it("dimensions dégénérées → plancher pair (2)", () => {
    const plan = buildEncodePlan({
      frameCount: 10,
      fps: 10,
      format: "mp4",
      width: 0,
      height: -10,
    });
    expect(argAfter(plan.ffmpegArgs, "-vf")).toContain("scale=2:2");
  });

  it("frameCount flottant est tronqué pour la durée", () => {
    const plan = buildEncodePlan({
      frameCount: 45.9,
      fps: 15,
      format: "mp4",
      width: 100,
      height: 100,
    });
    expect(plan.duration).toBeCloseTo(45 / 15, 10);
  });

  it("ffmpegArgs est toujours un tableau de chaînes non vide", () => {
    const plan = buildEncodePlan({
      frameCount: 1,
      fps: 1,
      format: "gif",
      width: 2,
      height: 2,
    });
    expect(Array.isArray(plan.ffmpegArgs)).toBe(true);
    expect(plan.ffmpegArgs.length).toBeGreaterThan(0);
    expect(plan.ffmpegArgs.every(a => typeof a === "string")).toBe(true);
  });
});
