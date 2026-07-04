import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // Les assets sous /assets portent un hash de contenu dans leur nom
  // (index-DAGjOk1d.js) : ils sont IMMUABLES par construction → cache navigateur
  // long (1 an, immutable). Sans cela, express.static (maxAge 0) force une
  // revalidation de chaque chunk à chaque visite. index.html, lui, reste servi
  // par le static générique ci-dessous (ETag/304) : c'est l'entrée mutable qui
  // référence les nouveaux hashes après un déploiement.
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    })
  );
  app.use(express.static(distPath));

  // Garde « chunk périmé » : un asset hashé manquant (chunk d'un ancien
  // déploiement) doit répondre 404 — PAS le fallback SPA. Sinon le navigateur
  // reçoit index.html (HTML) à la place d'un module JS → erreur MIME opaque au
  // lieu du `vite:preloadError` que la garde client (main.tsx) sait rattraper.
  app.use("/assets", (_req, res) => {
    res.status(404).end();
  });

  // Une route /api/* NON gérée ne doit JAMAIS retomber sur le fallback SPA :
  // renvoyer index.html (HTML, 200) sur un chemin d'API trompe les scanners de
  // sécurité (un « GET /api/studies » paraît « répondre 200 avec du contenu »
  // alors que c'est la coquille SPA, pas des données) — c'est exactement le
  // faux positif « fuite post-logout » remonté en QA. Réponse honnête : 404 JSON.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
