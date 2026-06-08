/**
 * Un UID DICOM est une suite de chiffres séparés par des points, max 64 caractères
 * (PS 3.5). On l'exige strictement avant de l'interpoler dans une URL Orthanc :
 * défense en profondeur contre le path traversal / SSRF.
 */
export function isValidDicomUid(uid: string): boolean {
  return (
    typeof uid === "string" &&
    /^[0-9]+(\.[0-9]+)*$/.test(uid) &&
    uid.length <= 64 &&
    uid.length > 0
  );
}

import type { Express, Request, Response } from "express";
import { Readable } from "node:stream";
import { sdk } from "./_core/sdk";
import { hasMedicalAccess } from "./rbac";
import { orthancFetch } from "./orthanc";
import { recordAccess } from "./db";

/**
 * Grammaire DICOMweb STRICTE : n'accepte QUE les chemins attendus de la forme
 *   studies/{uid}[/series/{uid}[/instances/{uid}[/frames/{n}]]][/metadata]
 *
 * Reconstruit l'URL upstream à partir des pièces validées et encodées individuel-
 * lement — JAMAIS à partir du reste brut — pour fermer tout path traversal / SSRF
 * vers l'API admin d'Orthanc (ex. `/tools/execute-script`, `../system`, etc.).
 */
export function buildOrthancPath(
  rest: string
): { path: string; study: string; isMetadata: boolean } | null {
  // Rejet préalable de tout caractère dangereux / double-encodage suspect.
  if (/(\.\.|\\|\?|#|%2e|%2f|%5c)/i.test(rest)) return null;

  const m = rest
    .replace(/^\/+/, "")
    .match(
      /^studies\/([^/]+)(?:\/series\/([^/]+)(?:\/instances\/([^/]+)(?:\/frames\/(\d+))?)?)?(\/metadata)?$/
    );
  if (!m) return null;

  const [, study, series, inst, frame, meta] = m;
  for (const uid of [study, series, inst].filter(Boolean) as string[]) {
    if (!isValidDicomUid(uid)) return null;
  }

  // Reconstruction encodée segment par segment — aucune interpolation de `rest`.
  let path = `/dicom-web/studies/${encodeURIComponent(study)}`;
  if (series) path += `/series/${encodeURIComponent(series)}`;
  if (inst) path += `/instances/${encodeURIComponent(inst)}`;
  if (frame) path += `/frames/${encodeURIComponent(frame)}`;
  const isMetadata = !!meta;
  if (isMetadata) path += `/metadata`;

  return { path, study, isMetadata };
}

export async function handleDicomwebRequest(
  req: Request,
  res: Response
): Promise<void> {
  // PHI : exiger une session + un rôle clinique avant de relayer le moindre octet.
  let user;
  try {
    user = await sdk.authenticateRequest(req as any);
  } catch {
    res.status(401).send("Unauthorized");
    return;
  }
  if (!hasMedicalAccess(user)) {
    res.status(403).send("Forbidden");
    return;
  }

  const rest = (req.params as Record<string, string>)[0] ?? "";
  const built = buildOrthancPath(rest);
  if (!built) {
    res.status(400).send("Bad path");
    return;
  }

  // Audit : une seule entrée par chargement de volume, sur la requête metadata
  // (qui identifie l'étude). On n'a que l'UID DICOM ici → studyId null, UID en detail.
  if (built.isMetadata) {
    await recordAccess({
      userId: (user as any).id,
      action: "mpr_volume_view",
      studyId: null,
      detail: `study=${built.study}`,
      ipAddress:
        (req.headers["x-forwarded-for"] as string) ?? (req as any).ip ?? null,
    });
  }

  try {
    const accept =
      (req.headers["accept"] as string) || "application/dicom+json";
    // Utiliser UNIQUEMENT built.path (reconstruit et encodé), jamais `rest`.
    const upstream = await orthancFetch(built.path, {
      method: "GET",
      headers: { Accept: accept },
    });

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");

    if (!upstream.ok || !upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
      return;
    }
    // Streaming passthrough (frames volumineuses). Node 20 : web ReadableStream → Node stream.
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    console.error("[DicomwebProxy] failed:", err);
    if (!(res as any).headersSent) res.status(502).send("DICOMweb proxy error");
  }
}

export function registerDicomwebProxy(app: Express) {
  app.get("/api/dicomweb/*", handleDicomwebRequest);
}
