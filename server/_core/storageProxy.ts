import type { Express } from "express";
import { sdk } from "./sdk";
import { hasMedicalAccess } from "../rbac";
import { isStorageConfigured, storageGetObject } from "../storage";
import { logger } from "./logger";
import { captureException } from "./sentry";

async function handleStorageRequest(
  key: string,
  req: Parameters<Parameters<Express["get"]>[1]>[0],
  res: Parameters<Parameters<Express["get"]>[1]>[1]
) {
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

  if (!key) {
    res.status(400).send("Missing storage key");
    return;
  }

  if (!isStorageConfigured()) {
    res.status(500).send("Storage proxy not configured");
    return;
  }

  try {
    const { body } = await storageGetObject(key);

    // Hardening: these bytes are served same-origin, so a malicious file
    // (e.g. HTML masquerading as a DICOM) must never be rendered/executed in
    // the app origin. Force an opaque, non-sniffable, download-only response
    // and ignore the stored Content-Type. Cornerstone loads via fetch/XHR,
    // so `attachment` doesn't affect viewing.
    // Les objets DICOM sont IMMUABLES (clé de stockage = contenu) et volumineux
    // (CT non compressé ~150 Mo/série). On autorise le cache PRIVÉ du navigateur
    // (jamais un cache partagé/CDN) pour que la ré-ouverture, le scroll et les
    // bascules 2D/MPR/3D ne re-téléchargent pas la série → chargement quasi
    // instantané après le 1er affichage. `private` + l'auth same-origin gardent
    // la PHI hors des caches partagés ; le cache disque reste sur la machine du
    // clinicien (comportement standard d'un viewer PACS).
    res.set("Cache-Control", "private, max-age=86400, immutable");
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", "attachment");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    body.on("error", err => {
      console.error("[StorageProxy] stream error:", err);
      if (!res.headersSent) res.status(502).send("Storage stream error");
      else res.destroy(err);
    });
    body.pipe(res);
  } catch (err) {
    logger.error("storageProxy.failed", { error: String(err) });
    captureException(err);
    console.error("[StorageProxy] failed:", err);
    res.status(502).send("Storage proxy error");
  }
}

export function registerStorageProxy(app: Express) {
  // Canonical route for new uploads.
  app.get("/storage/*", (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    handleStorageRequest(key, req, res);
  });

  // Legacy alias kept for backward compat — URLs stored in DB before the
  // rename still work without a full re-upload.
  app.get("/manus-storage/*", (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    handleStorageRequest(key, req, res);
  });
}
