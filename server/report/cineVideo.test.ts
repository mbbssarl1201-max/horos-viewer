import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { PNG } from "pngjs";
import { buildCineMp4, ffmpegAvailable } from "./cineVideo";

function grayFrame(v: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < 16 * 16; i++) {
    const o = i * 4;
    png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("buildCineMp4", () => {
  it("produit un MP4 non vide", async () => {
    expect(ffmpegAvailable()).toBe(true);
    const frames = [grayFrame(0), grayFrame(128), grayFrame(255)];
    const mp4 = await buildCineMp4(frames, { fps: 12 });
    expect(mp4.length).toBeGreaterThan(200);
    expect(mp4.subarray(4, 8).toString()).toBe("ftyp");
  });
});

describe("buildCineMp4 guard", () => {
  it("refuse moins de 2 frames", async () => {
    await expect(buildCineMp4([Buffer.from("x")], { fps: 12 })).rejects.toThrow(
      /2 frames/i
    );
  });
});
