import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import crypto from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerDicomwebProxy } from "../dicomwebProxy";
import { registerCockpitRoutes, attacherVncProxy } from "../cockpit.routes";
import { attacherProxyVoixVertex } from "../voix/vertexLiveProxy";
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

  // En-têtes de sécurité globaux (app médicale PHI). On reste sur des en-têtes
  // sûrs : PAS de Content-Security-Policy restrictive (casserait Cornerstone3D/
  // vtk.js : workers, blob:, wasm). frame-ancestors 'none' + X-Frame-Options DENY
  // = anti-clickjacking sur le viewer ; HSTS 2 ans ; nosniff ; referrer minimal.
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains"
    );
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  // Configure body parser with larger size limit for file uploads.
  // 160 Mo : les grosses coupes DICOM (mammographie MG ~50 Mo/image → ~67 Mo
  // base64, gros CT) rapatriées du PACS dépassent 50 Mo. Endpoints lourds
  // protégés par jeton de service + rate-limit (cf. dicom.import).
  app.use(express.json({ limit: "160mb" }));
  app.use(express.urlencoded({ limit: "160mb", extended: true }));

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
  // Limiteur dédié au point PUBLIC non authentifié `/r/:token` (rédemption d'un
  // lien de partage de CR) : il touche la DB avant tout contrôle d'accès, donc on
  // borne les tentatives par IP (défense en profondeur ; le token 256 bits rend
  // déjà le brute-force inatteignable).
  const RL_SHARE_MAX = parseInt(process.env.RATE_LIMIT_SHARE_MAX ?? "30");
  const shareLimiter = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: RL_SHARE_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Trop de requêtes, réessayez plus tard.",
  });
  app.use("/api", apiLimiter);
  app.use("/api/export", exportLimiter);
  app.use("/api/trpc", loginLimiter);
  app.use("/r", shareLimiter);
  // Colis assureur (`/dl/:token`) : même exposition qu'un lien public non
  // authentifié → même limiteur dédié que `/r/:token`.
  app.use("/dl", shareLimiter);

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
  attacherVncProxy(server);
  attacherProxyVoixVertex(server);

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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: unknown) =>
      res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const abortCtrl = new AbortController();
    req.on("close", () => abortCtrl.abort());

    try {
      // Vertex AI (Gemini) si disponible, sinon Ollama local
      const hasVertex =
        !!process.env.VERTEX_PROJECT &&
        !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (prep.useClaude || hasVertex) {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({
          vertexai: true,
          project: process.env.VERTEX_PROJECT ?? "optigps",
          location: process.env.VERTEX_LOCATION ?? "europe-west1",
        });
        const sysMsg =
          prep.messages.find((m: any) => m.role === "system")?.content ?? "";
        const contents = prep.messages
          .filter((m: any) => m.role !== "system")
          .map((m: any) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }));
        const gStream = await ai.models.generateContentStream({
          model: process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction: sysMsg,
            maxOutputTokens: 1200,
            temperature: 0.3,
          },
        });
        for await (const chunk of gStream) {
          if (abortCtrl.signal.aborted) break;
          const txt = ((chunk as any).candidates?.[0]?.content?.parts ?? [])
            .map((p: any) => p.text ?? "")
            .join("");
          if (txt) send({ t: txt });
        }
      } else {
        await streamOllamaChat(
          prep.messages,
          delta => send({ t: delta }),
          abortCtrl.signal
        );
      }
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
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj: unknown) =>
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const abortCtrl = new AbortController();
    req.on("close", () => abortCtrl.abort());

    try {
      const hasVertex =
        !!process.env.VERTEX_PROJECT &&
        !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (prep.useClaude || hasVertex) {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({
          vertexai: true,
          project: process.env.VERTEX_PROJECT ?? "optigps",
          location: process.env.VERTEX_LOCATION ?? "europe-west1",
        });
        const sysMsg =
          prep.messages.find((m: any) => m.role === "system")?.content ?? "";
        const contents = prep.messages
          .filter((m: any) => m.role !== "system")
          .map((m: any) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }));
        const gStream = await ai.models.generateContentStream({
          model: process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction: sysMsg,
            maxOutputTokens: 1200,
            temperature: 0.3,
          },
        });
        for await (const chunk of gStream) {
          if (abortCtrl.signal.aborted) break;
          const txt = ((chunk as any).candidates?.[0]?.content?.parts ?? [])
            .map((p: any) => p.text ?? "")
            .join("");
          if (txt) send({ t: txt });
        }
      } else {
        await streamOllamaChat(
          prep.messages,
          delta => send({ t: delta }),
          abortCtrl.signal
        );
      }
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

      const { buildStudyExportPdf } = await import("../report/reportPdf");
      const pdfBuffer = buildStudyExportPdf(study);
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

  // Lien OTP : accès public sécurisé à un CR signé (7j, usage unique, référent).
  // Redirige vers le viewer après validation du token. Pas de PHI dans l'URL.
  app.get("/r/:token", async (req, res) => {
    try {
      const { peekShareToken, consumeShareToken } = await import(
        "../report/reportShareToken"
      );
      const token = req.params.token as string;
      // 1. Validation LECTURE SEULE (peek) : un GET ne consomme jamais le token,
      //    sinon les scanners de liens email brûlent l'usage unique avant le clic
      //    humain (F2). Le peek survit aussi au détour par le login ci-dessous.
      const payload = await peekShareToken(token);
      if (!payload) {
        res.status(410).send("Lien expiré ou déjà utilisé.");
        return;
      }
      // 2. Accès RÉSERVÉ au personnel médical authentifié (conforme « authz
      //    dossier=médecin » ; surface PHI minimale). Les destinataires externes
      //    sans compte MediView reçoivent le compte rendu via le PDF joint à
      //    l'email — pas d'accès viewer en clair sans authentification (F1).
      const { sdk } = await import("./sdk");
      let user;
      try {
        user = await sdk.authenticateRequest(req as never);
      } catch {
        // Non authentifié → login. Le token n'ayant pas été consommé, le
        // destinataire re-clique le lien une fois connecté.
        res.redirect("/login");
        return;
      }
      const { hasMedicalAccess } = await import("../rbac");
      if (!hasMedicalAccess(user)) {
        res.status(403).send("Accès réservé au personnel médical.");
        return;
      }
      // 3. Accès accordé à un clinicien authentifié → consommation ATOMIQUE
      //    (usage unique, F4) + journalisation (audit nLPD), puis deep-link.
      const consumed = await consumeShareToken(token);
      if (!consumed) {
        res.status(410).send("Lien expiré ou déjà utilisé.");
        return;
      }
      try {
        const { recordAccess } = await import("../db");
        await recordAccess({
          userId: user.id,
          action: "report.share.open",
          studyId: consumed.studyId,
          ipAddress: req.ip ?? null,
        });
      } catch {
        /* audit best-effort */
      }
      res.redirect(`/viewer/${consumed.studyId}`);
    } catch {
      res.status(500).send("Erreur serveur.");
    }
  });

  // Colis DICOM+CR d'une demande assureur : jeton en clair dans l'URL (256
  // bits, non énumérable), pas de session requise (le destinataire assureur
  // n'a pas de compte MediView). Multi-téléchargement INTENTIONNEL pendant la
  // fenêtre de validité (14 j), plafonné à 10 rédemptions (cf. I2) — le
  // message 410 générique ci-dessous couvre donc inconnu/expiré/révoqué/
  // plafond atteint, sans distinguer ces cas (pas d'oracle) ; formulation
  // dédiée (≠ `/r/:token`, lien usage unique) pour ne pas suggérer à tort
  // qu'un seul téléchargement suffit à invalider le lien.
  app.get("/dl/:token", async (req, res) => {
    try {
      const { racheterJeton } = await import("../insurer/bundle");
      const token = req.params.token as string;
      const result = await racheterJeton(token, req.ip ?? "");
      if (!result.ok) {
        res.status(410).send("Lien expiré ou révoqué.");
        return;
      }
      const { storageGetObject } = await import("../storage");
      const { body } = await storageGetObject(result.bundleKey);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="imagerie.zip"'
      );
      body.on("error", err => {
        console.error("[dl] stream error:", err);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      });
      body.pipe(res);
    } catch {
      if (!res.headersSent) res.status(500).send("Erreur serveur.");
    }
  });

  // Backfill PACS : la passerelle du cabinet demande la liste des études
  // (UID/accession, ZÉRO PHI) réclamées par une demande assureur en cours et
  // encore dépourvues d'images, pour les rapatrier via C-GET puis dicom.import.
  // Même jeton Bearer que dicom.import (restreint à l'IP du cabinet par Traefik).
  app.get("/api/insurer/etudes-a-rapatrier", async (req, res) => {
    const { isValidImportToken } = await import("../importToken");
    if (!isValidImportToken(req.headers.authorization)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const { espaceLibreOctets } = await import("../insurer/espaceDisque");
      const { etudesARapatrier } = await import("../insurer/backfill");
      const libre = await espaceLibreOctets("/");
      const studies = await etudesARapatrier(libre);
      res.json({ studies });
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error)?.message || "Erreur" });
    }
  });

  // Pièce jointe d'une demande assureur (feuille SUVA scannée…) : le gérant
  // doit pouvoir VOIR le document reçu pour confirmer l'extraction avant
  // d'envoyer. Session clinique obligatoire ; la clé est bornée aux
  // attachmentKeys de LA demande (pas de traversée arbitraire de MinIO).
  app.get("/api/insurer/piece/:requestId/:idx", async (req, res) => {
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
      const requestId = parseInt(req.params.requestId);
      const idx = parseInt(req.params.idx);
      if (Number.isNaN(requestId) || Number.isNaN(idx) || idx < 0) {
        res.status(400).json({ error: "Bad request" });
        return;
      }
      const { getDb } = await import("../db");
      const { insurerRequests } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "DB" });
        return;
      }
      const rows = await db
        .select({ attachmentKeys: insurerRequests.attachmentKeys })
        .from(insurerRequests)
        .where(eq(insurerRequests.id, requestId))
        .limit(1);
      const keys = (rows[0]?.attachmentKeys as string[] | null) ?? [];
      const key = keys[idx];
      if (!key) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const { storageGetBuffer } = await import("../storage");
      const buf = await storageGetBuffer(key);
      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "pdf"
              ? "application/pdf"
              : "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buf);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "Erreur" });
    }
  });

  // ── INTÉGRATION MEDICENTRAL (service-to-service, réseau interne medical-net) ──
  // MediCentral appelle ces routes avec le token partagé MEDICENTRAL_SERVICE_TOKEN
  // pour afficher les études + comptes-rendus d'un patient dans SON dossier. OFF
  // tant que le token n'est pas configuré (aucune surface exposée). Pas de session
  // MediView requise : l'authz patient est faite côté MediCentral (cabinet).
  const serviceTokenOk = (req: express.Request): boolean => {
    const attendu = (process.env.MEDICENTRAL_SERVICE_TOKEN || "").trim();
    // Désactivé si non configuré OU trop court : ces routes exposent du PHI sans
    // session MediView, un jeton faible serait brute-forçable (cf. importToken.ts).
    if (attendu.length < 32) return false;
    const recu = String(req.header("x-service-token") || "");
    // Comparaison en temps constant sur des empreintes de longueur fixe : ne fuit
    // pas la longueur du jeton attendu (pas d'early-return sur recu.length).
    const a = crypto.createHash("sha256").update(attendu).digest();
    const b = crypto.createHash("sha256").update(recu).digest();
    return crypto.timingSafeEqual(a, b);
  };

  app.post("/api/interne/imagerie-patient", async (req, res) => {
    if (!serviceTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const { nom, prenom, ddn } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof nom !== "string" || typeof prenom !== "string") {
        res.status(400).json({ error: "nom/prenom requis" });
        return;
      }
      const { imageriePatientPourMedicentral } = await import("../db");
      const r = await imageriePatientPourMedicentral({
        nom,
        prenom,
        ddn: typeof ddn === "string" ? ddn : null,
      });
      res.json(r);
    } catch (e: unknown) {
      res.status(500).json({ error: (e as Error)?.message || "Erreur" });
    }
  });

  app.get("/api/interne/cr-pdf/:studyId", async (req, res) => {
    if (!serviceTokenOk(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const studyId = parseInt(req.params.studyId, 10);
      if (!Number.isInteger(studyId)) {
        res.status(400).json({ error: "studyId invalide" });
        return;
      }
      const { getReportByStudy, getStudyById } = await import("../db");
      const report = (await getReportByStudy(studyId)) as Record<
        string,
        unknown
      > | null;
      if (!report) {
        res.status(404).json({ error: "Aucun compte-rendu" });
        return;
      }
      const pdfKey = report.pdfStorageKey as string | null | undefined;
      if (pdfKey) {
        const { storageGetBuffer } = await import("../storage");
        const buf = await storageGetBuffer(pdfKey);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="CR_${studyId}.pdf"`
        );
        res.send(buf);
        return;
      }
      // Pas de PDF signé stocké → génération à la volée depuis les sections.
      const { decryptField } = await import("./crypto");
      const study = await getStudyById(studyId);
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();
      const champ = (v: unknown) => decryptField(v as string) || "—";
      let y = 20;
      doc.setFontSize(16);
      doc.setTextColor(0, 102, 204);
      doc.text("Compte rendu radiologique", 20, y);
      doc.setDrawColor(0, 102, 204);
      doc.line(20, y + 4, 190, y + 4);
      y += 16;
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0);
      doc.text(`Patient : ${study?.patientName || "—"}`, 20, y);
      y += 7;
      doc.text(
        `Étude : ${study?.modality || "—"} — ${study?.studyDate || "—"}`,
        20,
        y
      );
      y += 11;
      const section = (titre: string, texte: string) => {
        doc.setFontSize(11);
        doc.setTextColor(0, 102, 204);
        doc.text(titre, 20, y);
        y += 6;
        doc.setFontSize(10);
        doc.setTextColor(0, 0, 0);
        for (const ligne of doc.splitTextToSize(texte, 170)) {
          if (y > 275) {
            doc.addPage();
            y = 20;
          }
          doc.text(ligne, 20, y);
          y += 6;
        }
        y += 4;
      };
      section("Indication", champ(report.indication));
      section("Technique", champ(report.technique));
      section("Résultats", champ(report.resultats));
      section("Conclusion", champ(report.conclusion));
      const buf = Buffer.from(doc.output("arraybuffer"));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="CR_${studyId}.pdf"`
      );
      res.send(buf);
    } catch (e: unknown) {
      if (!res.headersSent)
        res.status(500).json({ error: (e as Error)?.message || "Erreur" });
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

  // Agent assureur (SUVA) : poller IMAP + pipeline de traitement des
  // demandes d'imagerie (no-op si INSURER_IMAP_HOST absent).
  void import("../insurer/mailPoller")
    .then(m => m.demarrerPollerAssureur())
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
