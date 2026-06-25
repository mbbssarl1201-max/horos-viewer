import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerDicomwebProxy } from "../dicomwebProxy";
import { registerCockpitRoutes } from "../cockpit.routes";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { logger } from "./logger";
import { initSentry } from "./sentry";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Behind Traefik/proxies: trust the first hop so rate-limit keys on the
  // real client IP (from X-Forwarded-For) rather than the proxy's.
  app.set("trust proxy", 1);

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Rate limiting (DoS / abuse mitigation). DICOM import is ONE request per
  // instance, so a single study (often 100s–1000s of slices) bursts many
  // requests — the cap must be high enough not to cut a legitimate import off
  // mid-upload. Defaults are generous; tune via env without a rebuild.
  const RL_WINDOW_MS = parseInt(
    process.env.RATE_LIMIT_WINDOW_MS ?? `${15 * 60 * 1000}`
  );
  const RL_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "6000");
  const RL_EXPORT_MAX = parseInt(process.env.RATE_LIMIT_EXPORT_MAX ?? "120");
  const apiLimiter = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: RL_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  const exportLimiter = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: RL_EXPORT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many export requests, please try again later." },
  });
  // Anti-brute-force dédié sur la connexion (audit H3) : le limiteur global
  // (RL_MAX, 6000/fenêtre) est bien trop large pour protéger `auth.login`. Comme
  // le client tRPC BATCHE les appels (httpBatchLink), on ne peut pas cibler un
  // chemin fixe ; on monte le limiteur sur tout `/api/trpc` mais on ne COMPTE
  // que les requêtes dont l'URL référence `auth.login` (robuste au batching,
  // même si l'attaquant combine login + autre procédure). Clé = IP.
  const RL_LOGIN_MAX = parseInt(process.env.RATE_LIMIT_LOGIN_MAX ?? "10");
  const loginLimiter = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: RL_LOGIN_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: req => !req.originalUrl.includes("auth.login"),
    message: { error: "Too many login attempts, please try again later." },
  });
  app.use("/api", apiLimiter);
  app.use("/api/export", exportLimiter);
  app.use("/api/trpc", loginLimiter);

  // CSRF mitigation for the PHI export GET routes: a cross-site context (e.g. a
  // malicious page triggering a navigation/download) is rejected. Same-origin
  // app requests ("same-origin"/"same-site") and direct user navigations
  // ("none", e.g. typing the URL) are allowed.
  app.use("/api/export", (req, res, next) => {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site request blocked" });
      return;
    }
    next();
  });

  // CSRF mitigation for the tRPC API (audit H2): tRPC mutations are
  // state-changing and PHI-bearing, and are only ever called same-origin by the
  // SPA. A cross-site context is rejected. As with the export guard, an absent
  // header (older browsers, non-browser clients) and same-origin/same-site/none
  // are allowed — the Bearer-authenticated public API lives under /api/v1, not
  // /api/trpc, so it is unaffected.
  app.use("/api/trpc", (req, res, next) => {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site request blocked" });
      return;
    }
    next();
  });

  // Public health probe (no auth, no PHI). Returns 200 when DB + storage are
  // reachable, 503 otherwise — suitable for Docker/Traefik healthchecks.
  const startedAt = Date.now();
  app.get("/healthz", async (_req, res) => {
    let dbOk = false;
    let storageOk = false;
    try {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (db) {
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`SELECT 1`);
        dbOk = true;
      }
    } catch {
      dbOk = false;
    }
    try {
      const { isStorageConfigured } = await import("../storage");
      // Light check: configured is enough here — a full S3 round-trip on every
      // probe would add load and a network dependency to liveness.
      storageOk = isStorageConfigured();
    } catch {
      storageOk = false;
    }
    const healthy = dbOk && storageOk;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      db: dbOk ? "up" : "down",
      storage: storageOk ? "ok" : "unconfigured",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  registerStorageProxy(app);
  registerDicomwebProxy(app);
  registerOAuthRoutes(app);
  registerCockpitRoutes(app);

  // Authenticated CSV export of the audit trail (access_logs) — admin only.
  // Mirrors the audit.export tRPC procedure but streams a downloadable CSV.
  app.get("/api/audit/export.csv", async (req, res) => {
    try {
      const { sdk } = await import("./sdk");
      const { isAdmin } = await import("../rbac");
      let user;
      try {
        user = await sdk.authenticateRequest(req as any);
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!isAdmin(user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const { queryAuditLogs, buildAuditCsv } = await import("../audit");
      const { recordAccess } = await import("../db");
      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== "string" || !v) return undefined;
        const d = new Date(v);
        return isNaN(d.getTime()) ? undefined : d;
      };
      const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
      const rows = await queryAuditLogs({
        from: parseDate(req.query.from),
        to: parseDate(req.query.to),
        limit: Number.isNaN(limitRaw) ? undefined : limitRaw,
      });
      await recordAccess({
        userId: user.id,
        action: "audit.export.csv",
        studyId: null,
        detail: `rows=${rows.length}`,
        ipAddress: req.ip ?? null,
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="audit-logs.csv"`
      );
      res.send(buildAuditCsv(rows));
    } catch (err: any) {
      logger.error("audit.export_csv_failed", { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: "Audit export failed" });
      }
    }
  });
  // Chat Hermès en streaming (tokens token-par-token, modèle LOCAL). SSE.
  // Auth = medicalProcedure (clinique). Anti-IDOR + rate-limit dans prepareHermesChat.
  app.post("/api/hermes/chat/stream", async (req, res) => {
    // CSRF (audit H2) : route PHI state-changing, appelée uniquement same-origin
    // par la SPA. Un contexte cross-site est rejeté (même garde que /api/trpc).
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site request blocked" });
      return;
    }
    const { sdk } = await import("./sdk");
    const { hasMedicalAccess } = await import("../rbac");
    let user;
    try {
      user = await sdk.authenticateRequest(req as any);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!hasMedicalAccess(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    // Validation minimale de l'entrée
    const body = req.body ?? {};
    const studyId = Number(body.studyId);
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!Number.isInteger(studyId) || !messages || messages.length === 0) {
      res.status(400).json({ error: "Bad request" });
      return;
    }

    const { prepareHermesChat } = await import("../report/hermesChat");
    const { streamOllamaChat } = await import("../knowledge/stream");

    let prep;
    try {
      prep = await prepareHermesChat(
        { studyId, messages },
        { user: { id: user.id } }
      );
    } catch (err: any) {
      const code =
        err?.code === "TOO_MANY_REQUESTS"
          ? 429
          : err?.code === "NOT_FOUND"
            ? 404
            : 500;
      res.status(code).json({ error: err?.message ?? "Erreur" });
      return;
    }

    // Si garde H4 (Claude) active : pas de streaming → 409, le client bascule en non-streaming.
    if (prep.useClaude) {
      res.status(409).json({ error: "streaming indisponible (backend cloud)" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: unknown) =>
      res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Si le client ferme la connexion, on avorte le flux Ollama (pas de CPU
    // gaspillé sur le VPS contendu).
    const abortCtrl = new AbortController();
    req.on("close", () => abortCtrl.abort());

    try {
      await streamOllamaChat(
        prep.messages,
        delta => send({ t: delta }),
        abortCtrl.signal
      );
      const { recordAccess } = await import("../db");
      await recordAccess({
        userId: user.id,
        action: "ai.hermes.chat",
        studyId: prep.study.id,
        detail: prep.model,
        ipAddress: req.ip ?? null,
      });
      send({ done: true, sources: prep.sources, model: prep.model });
      res.end();
    } catch (err: any) {
      logger.error("hermes.stream_failed", { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: "stream failed" });
      } else {
        send({ error: "stream interrompu" });
        res.end();
      }
    }
  });
  // Rédaction assistée du CR en streaming (modèle LOCAL). SSE. Auth = éditeur de
  // CR (admin|radiologist), comme adminProcedure. RAG + anti-invention côté serveur.
  app.post("/api/hermes/report-assist/stream", async (req, res) => {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site request blocked" });
      return;
    }
    const { sdk } = await import("./sdk");
    let user;
    try {
      user = await sdk.authenticateRequest(req as any);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (user.role !== "admin" && user.role !== "radiologist") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const { ASSIST_ACTIONS } = await import("../report/reportAssist");
    const body = req.body ?? {};
    const studyId = Number(body.studyId);
    const action = body.action;
    // Borne anti-DoS : une section de CR raisonnable tient largement en 20k car.
    const currentText =
      typeof body.currentText === "string"
        ? body.currentText.slice(0, 20_000)
        : "";
    if (!Number.isInteger(studyId) || !ASSIST_ACTIONS.includes(action)) {
      res.status(400).json({ error: "Bad request" });
      return;
    }

    const { prepareReportAssist } = await import("../report/reportAssist");
    const { streamOllamaChat } = await import("../knowledge/stream");
    let prep;
    try {
      prep = await prepareReportAssist(
        { studyId, action, currentText },
        { user: { id: user.id } }
      );
    } catch (err: any) {
      const code =
        err?.code === "TOO_MANY_REQUESTS"
          ? 429
          : err?.code === "NOT_FOUND"
            ? 404
            : 500;
      res.status(code).json({ error: err?.message ?? "Erreur" });
      return;
    }
    if (prep.useClaude) {
      res.status(409).json({ error: "streaming indisponible (backend cloud)" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: unknown) =>
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const abortCtrl = new AbortController();
    req.on("close", () => abortCtrl.abort());

    try {
      await streamOllamaChat(
        prep.messages,
        delta => send({ t: delta }),
        abortCtrl.signal
      );
      const { recordAccess } = await import("../db");
      await recordAccess({
        userId: user.id,
        action: "ai.hermes.assist",
        studyId: prep.study.id,
        detail: `${action}:${prep.model}`,
        ipAddress: req.ip ?? null,
      });
      send({ done: true, model: prep.model });
      res.end();
    } catch (err: any) {
      logger.error("hermes.assist_stream_failed", { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: "stream failed" });
      else {
        send({ error: "stream interrompu" });
        res.end();
      }
    }
  });
  // Export routes (ZIP DICOM + PDF) - must be before tRPC
  app.get("/api/export/dicom-zip/:studyId", async (req, res) => {
    try {
      const { sdk } = await import("./sdk");
      const { hasMedicalAccess } = await import("../rbac");
      let user;
      try {
        user = await sdk.authenticateRequest(req as any);
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!hasMedicalAccess(user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const studyId = parseInt(req.params.studyId);
      if (isNaN(studyId)) {
        res.status(400).json({ error: "Invalid study ID" });
        return;
      }

      const {
        listSeriesByStudy,
        listInstancesBySeries,
        getStudyById,
        recordAccess,
      } = await import("../db");
      const { storageGetSignedUrl } = await import("../storage");

      const study = await getStudyById(studyId);
      if (!study) {
        res.status(404).json({ error: "Study not found" });
        return;
      }

      await recordAccess({
        userId: user.id,
        action: "study.export.dicom",
        studyId,
        ipAddress: req.ip ?? null,
      });

      const seriesList = await listSeriesByStudy(studyId);
      if (seriesList.length === 0) {
        res.status(404).json({ error: "No series found" });
        return;
      }

      const archiver = (await import("archiver")).default;
      const archive = archiver("zip", { zlib: { level: 5 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="study_${studyId}_dicom.zip"`
      );
      archive.pipe(res);

      // Liste de toutes les instances à inclure, puis récupération depuis MinIO
      // PAR LOTS PARALLÈLES (≈8x plus rapide que séquentiel sur les grandes
      // séries — c'est de l'I/O réseau). On ajoute chaque fichier au ZIP au fur
      // et à mesure (archiver streame vers la réponse).
      const tasks: { key: string; name: string }[] = [];
      for (const s of seriesList) {
        const instanceList = await listInstancesBySeries(s.id);
        for (const inst of instanceList) {
          if (inst.storageKey) {
            tasks.push({
              key: inst.storageKey,
              name: `series_${s.seriesNumber || s.id}/${inst.sopInstanceUid || inst.id}.dcm`,
            });
          }
        }
      }
      const CONCURRENCY = 8;
      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async t => {
            try {
              const signedUrl = await storageGetSignedUrl(t.key);
              const fileResp = await fetch(signedUrl);
              if (!fileResp.ok) return null;
              return {
                name: t.name,
                buffer: Buffer.from(await fileResp.arrayBuffer()),
              };
            } catch (e) {
              console.warn(`[Export] échec récupération ${t.key}:`, e);
              return null;
            }
          })
        );
        for (const r of results) {
          if (r) archive.append(r.buffer, { name: r.name });
        }
      }

      await archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Export failed" });
      }
    }
  });

  app.get("/api/export/pdf-report/:studyId", async (req, res) => {
    try {
      const { sdk } = await import("./sdk");
      const { hasMedicalAccess } = await import("../rbac");
      let user;
      try {
        user = await sdk.authenticateRequest(req as any);
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!hasMedicalAccess(user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const studyId = parseInt(req.params.studyId);
      if (isNaN(studyId)) {
        res.status(400).json({ error: "Invalid study ID" });
        return;
      }

      const { getStudyById, recordAccess } = await import("../db");
      const study = await getStudyById(studyId);
      if (!study) {
        res.status(404).json({ error: "Study not found" });
        return;
      }

      await recordAccess({
        userId: user.id,
        action: "study.export.pdf",
        studyId,
        ipAddress: req.ip ?? null,
      });

      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();

      // Header
      doc.setFontSize(18);
      doc.setTextColor(0, 102, 204);
      doc.text("Radiology Report", 20, 20);
      doc.setDrawColor(0, 102, 204);
      doc.line(20, 24, 190, 24);

      // Patient info
      doc.setFontSize(12);
      doc.setTextColor(0, 0, 0);
      doc.text("Patient Information", 20, 35);
      doc.setFontSize(10);
      doc.text(`Name: ${study.patientName || "N/A"}`, 25, 43);
      doc.text(`Patient ID: ${study.patientId || "N/A"}`, 25, 50);
      doc.text(`Date of Birth: ${study.birthDate || "N/A"}`, 25, 57);

      // Study info
      doc.setFontSize(12);
      doc.text("Study Information", 20, 70);
      doc.setFontSize(10);
      doc.text(`Study Date: ${study.studyDate || "N/A"}`, 25, 78);
      doc.text(`Modality: ${study.modality || "N/A"}`, 25, 85);
      doc.text(`Description: ${study.studyDescription || "N/A"}`, 25, 92);
      doc.text(`Institution: ${study.institution || "N/A"}`, 25, 99);
      doc.text(
        `Referring Physician: ${study.referringPhysician || "N/A"}`,
        25,
        106
      );
      doc.text(`Number of Series: ${study.numberOfSeries || 0}`, 25, 113);
      doc.text(`Number of Images: ${study.numberOfInstances || 0}`, 25, 120);

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(`Generated: ${new Date().toISOString()}`, 20, 280);
      doc.text("MediView - For diagnostic purposes only", 20, 286);

      const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="report_study_${studyId}.pdf"`
      );
      res.send(pdfBuffer);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "PDF generation failed" });
      }
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Observability opt-in: enables Sentry only if SENTRY_DSN is set AND
  // @sentry/node is installed (no-op otherwise). Never throws.
  await initSentry();

  // Récupération : les analyses exhaustives en cours au moment d'un précédent
  // arrêt sont marquées « interrompues » (leur calcul en mémoire est perdu),
  // pour que le client affiche « relancez » au lieu d'un avancement figé.
  void import("../db").then(m => m.recoverStaleAiJobs()).catch(() => {});

  // Agent CR autonome : génère les brouillons des nouvelles études (si activé).
  void import("../report/autoReportAgent")
    .then(m => m.startAutoReportAgent())
    .catch(() => {});

  server.listen(port, () => {
    logger.info("server.started", { port, env: process.env.NODE_ENV });
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(err => {
  logger.error("server.start_failed", { error: String(err) });
  console.error(err);
});
