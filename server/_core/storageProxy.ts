import type { Express } from "express";
import { ENV } from "./env";
import { sdk } from "./sdk";
import { hasMedicalAccess } from "../rbac";

export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    // Stored objects are raw patient DICOM (PHI). Require an authenticated
    // session with a clinical role before handing out a signed download URL.
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

    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
