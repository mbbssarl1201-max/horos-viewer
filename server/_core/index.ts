import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

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

  // Rate limiting (DoS / abuse mitigation). General cap on the whole API,
  // plus a tighter cap on the PHI export routes that stream patient data.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  const exportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many export requests, please try again later." },
  });
  app.use("/api", apiLimiter);
  app.use("/api/export", exportLimiter);

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // Export routes (ZIP DICOM + PDF) - must be before tRPC
  app.get("/api/export/dicom-zip/:studyId", async (req, res) => {
    try {
      const { sdk } = await import("./sdk");
      const { hasMedicalAccess } = await import("../rbac");
      let user;
      try {
        user = await sdk.authenticateRequest(req as any);
      } catch {
        res.status(401).json({ error: "Unauthorized" }); return;
      }
      if (!hasMedicalAccess(user)) { res.status(403).json({ error: "Forbidden" }); return; }

      const studyId = parseInt(req.params.studyId);
      if (isNaN(studyId)) { res.status(400).json({ error: "Invalid study ID" }); return; }

      const { listSeriesByStudy, listInstancesBySeries, getStudyById } = await import("../db");
      const { storageGetSignedUrl } = await import("../storage");

      const study = await getStudyById(studyId);
      if (!study) { res.status(404).json({ error: "Study not found" }); return; }

      const seriesList = await listSeriesByStudy(studyId);
      if (seriesList.length === 0) { res.status(404).json({ error: "No series found" }); return; }

      const archiver = (await import("archiver")).default;
      const archive = archiver("zip", { zlib: { level: 5 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="study_${studyId}_dicom.zip"`);
      archive.pipe(res);

      for (const s of seriesList) {
        const instanceList = await listInstancesBySeries(s.id);
        for (const inst of instanceList) {
          if (inst.storageKey) {
            try {
              const signedUrl = await storageGetSignedUrl(inst.storageKey);
              const fileResp = await fetch(signedUrl);
              if (fileResp.ok) {
                const buffer = Buffer.from(await fileResp.arrayBuffer());
                const filename = `series_${s.seriesNumber || s.id}/${inst.sopInstanceUid || inst.id}.dcm`;
                archive.append(buffer, { name: filename });
              }
            } catch (e) {
              console.warn(`[Export] Failed to fetch instance ${inst.id}:`, e);
            }
          }
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
        res.status(401).json({ error: "Unauthorized" }); return;
      }
      if (!hasMedicalAccess(user)) { res.status(403).json({ error: "Forbidden" }); return; }

      const studyId = parseInt(req.params.studyId);
      if (isNaN(studyId)) { res.status(400).json({ error: "Invalid study ID" }); return; }

      const { getStudyById } = await import("../db");
      const study = await getStudyById(studyId);
      if (!study) { res.status(404).json({ error: "Study not found" }); return; }

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
      doc.text(`Referring Physician: ${study.referringPhysician || "N/A"}`, 25, 106);
      doc.text(`Number of Series: ${study.numberOfSeries || 0}`, 25, 113);
      doc.text(`Number of Images: ${study.numberOfInstances || 0}`, 25, 120);

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(100, 100, 100);
      doc.text(`Generated: ${new Date().toISOString()}`, 20, 280);
      doc.text("Horos Medical Imaging Viewer - For diagnostic purposes only", 20, 286);

      const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="report_study_${studyId}.pdf"`);
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

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
