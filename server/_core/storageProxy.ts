import type { Express } from "express";
import { sdk } from "./sdk";
import { hasMedicalAccess } from "../rbac";
import { isStorageConfigured, storageGetObject } from "../storage";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    // Stored objects are raw patient DICOM (PHI). Require an authenticated
    // session with a clinical role before streaming any bytes.
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

    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    if (!isStorageConfigured()) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      // Stream the object straight from S3/MinIO to the client. The bucket
      // stays private (no presigned URL handed to the browser).
      const { body } = await storageGetObject(key);

      // Hardening: these bytes are served same-origin, so a malicious file
      // (e.g. HTML masquerading as a DICOM) must never be rendered/executed in
      // the app origin. Force an opaque, non-sniffable, download-only response
      // and ignore the stored Content-Type. Cornerstone loads via fetch/XHR,
      // so `attachment` doesn't affect viewing.
      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "application/octet-stream");
      res.set("Content-Disposition", "attachment");
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "default-src 'none'; sandbox");
      body.on("error", (err) => {
        console.error("[StorageProxy] stream error:", err);
        if (!res.headersSent) res.status(502).send("Storage stream error");
        else res.destroy(err);
      });
      body.pipe(res);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
