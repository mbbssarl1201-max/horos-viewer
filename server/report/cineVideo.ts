import { execFile, execFileSync } from "child_process";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CineOptions {
  fps: number;
}

/**
 * Assemble une suite de frames PNG en MP4 H.264 (yuv420p, compat large).
 * Écrit les frames dans un dossier temporaire ÉPHÉMÈRE supprimé en fin
 * (les frames contiennent de la PHI — jamais persistées hors temp).
 */
export async function buildCineMp4(
  frames: Buffer[],
  opts: CineOptions
): Promise<Buffer> {
  if (frames.length < 2)
    throw new Error("Au moins 2 frames requises pour un ciné");
  const dir = await mkdtemp(join(tmpdir(), "horos-cine-"));
  try {
    await Promise.all(
      frames.map((f, i) =>
        writeFile(join(dir, `frame-${String(i + 1).padStart(5, "0")}.png`), f)
      )
    );
    const out = join(dir, "cine.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      String(opts.fps),
      "-i",
      join(dir, "frame-%05d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-movflags",
      "+faststart",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
