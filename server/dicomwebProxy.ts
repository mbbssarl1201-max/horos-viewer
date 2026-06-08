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
 * Découpe le chemin DICOMweb capturé (`studies/{uid}/series/{uid}/instances/{uid}[/frames/{n}]`
 * ou `.../metadata`) et valide chaque UID. Renvoie null si un segment UID est invalide.
 */
export function parseDicomwebPath(
  rest: string
): { study?: string; series?: string; isMetadata: boolean } | null {
  const clean = decodeURIComponent(rest).replace(/^\/+/, "");
  const isMetadata = clean.endsWith("/metadata");
  const parts = clean.split("/");
  let study: string | undefined;
  let series: string | undefined;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "studies") study = parts[i + 1];
    if (parts[i] === "series") series = parts[i + 1];
    if (parts[i] === "instances" && !isValidDicomUid(parts[i + 1])) return null;
  }
  if (study !== undefined && !isValidDicomUid(study)) return null;
  if (series !== undefined && !isValidDicomUid(series)) return null;
  return { study, series, isMetadata };
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
  const parsed = parseDicomwebPath(rest);
  if (!parsed) {
    res.status(400).send("Invalid DICOM UID");
    return;
  }

  // Audit : une seule entrée par chargement de volume, sur la requête metadata
  // (qui identifie l'étude). On n'a que l'UID DICOM ici → studyId null, UID en detail.
  if (parsed.isMetadata && parsed.study) {
    await recordAccess({
      userId: (user as any).id,
      action: "mpr_volume_view",
      studyId: null,
      detail: `study=${parsed.study}`,
      ipAddress:
        (req.headers["x-forwarded-for"] as string) ?? (req as any).ip ?? null,
    });
  }

  try {
    const orthancPath = `/dicom-web/${decodeURIComponent(rest).replace(/^\/+/, "")}`;
    const accept =
      (req.headers["accept"] as string) || "application/dicom+json";
    const upstream = await orthancFetch(orthancPath, {
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
