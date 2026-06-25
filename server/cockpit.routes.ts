// server/cockpit.routes.ts
//
// Routes API du COCKPIT Eva-Selenium (MediView) :
//   GET  /api/cockpit/viewer   → page HTML noVNC (même-origine, auth requise)
//   POST /api/cockpit/naviguer → proxy vers eva-capture-mediview
//
// Sécurité : pages restreintes à un jeu fermé (anti open-redirect) ;
// credentials VNC uniquement dans la réponse serveur (jamais dans le JS client) ;
// les deux routes exigent un utilisateur authentifié (hasMedicalAccess).
import type { Express, Request, Response, NextFunction } from "express";

const PAGES_AUTORISEES = new Set(["/", "/admin/knowledge", "/knowledge"]);

function pageAutorisee(page: string): boolean {
  if (!page || !page.startsWith("/")) return false;
  const clean = page.split("?")[0]!.split("#")[0]!;
  return (
    PAGES_AUTORISEES.has(clean) ||
    /^\/viewer\/\d+$/.test(clean) ||
    /^\/viewer$/.test(clean)
  );
}

function buildViewerHtml(liveWsUrl: string, vncPassword: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1220;overflow:hidden;width:100vw;height:100vh}
#screen{width:100%;height:100%}
#msg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  color:#7ee0c8;font-family:system-ui,sans-serif;font-size:14px;text-align:center;
  pointer-events:none;transition:opacity .3s}
</style>
</head>
<body>
<div id="screen"></div>
<div id="msg">Connexion au navigateur en direct…</div>
<script type="module">
import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/core/rfb.js';
const msg = document.getElementById('msg');
try {
  const rfb = new RFB(
    document.getElementById('screen'),
    ${JSON.stringify(liveWsUrl)},
    { credentials: { password: ${JSON.stringify(vncPassword)} } }
  );
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.background = '#0b1220';
  rfb.addEventListener('connect', () => {
    if (msg) { msg.style.opacity = '0'; setTimeout(() => { msg.style.display = 'none'; }, 300); }
  });
  rfb.addEventListener('disconnect', () => {
    if (msg) { msg.textContent = 'Déconnecté. Rechargez pour reconnecter.'; msg.style.display = 'block'; msg.style.opacity = '1'; }
  });
} catch (e) {
  if (msg) msg.textContent = 'Erreur noVNC : ' + (e instanceof Error ? e.message : String(e));
}
</script>
</body>
</html>`;
}

async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sdk } = await import("./_core/sdk");
    const { hasMedicalAccess } = await import("./rbac");
    const user = await sdk.authenticateRequest(req as any);
    if (!hasMedicalAccess(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export function registerCockpitRoutes(app: Express): void {
  const rawLiveUrl = (process.env.EVA_LIVE_URL ?? "").replace(/\/$/, "");
  const vncPassword = process.env.EVA_VNC_PASSWORD ?? "";
  const captureUrl = (process.env.EVA_CAPTURE_URL ?? "").replace(/\/$/, "");
  const captureSecret = process.env.EVA_CAPTURE_SECRET ?? "";

  // https:// → wss:// pour WebSocket noVNC
  const liveWsUrl = rawLiveUrl
    ? rawLiveUrl.replace(/^https?:\/\//, "wss://") + "/websockify"
    : "";

  app.get(
    "/api/cockpit/viewer",
    requireAuth,
    (_req: Request, res: Response): void => {
      if (!liveWsUrl || !vncPassword) {
        res.status(503).send("Service navigateur live non configuré.");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Cache-Control", "no-store");
      res.send(buildViewerHtml(liveWsUrl, vncPassword));
    }
  );

  app.post(
    "/api/cockpit/naviguer",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      if (!captureUrl || !captureSecret) {
        res
          .status(503)
          .json({ ok: false, message: "Service capture non configuré." });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const page = typeof body.page === "string" ? body.page : "";
      if (!pageAutorisee(page)) {
        res.status(400).json({ ok: false, message: "Page non autorisée." });
        return;
      }
      try {
        const r = await fetch(`${captureUrl}/naviguer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${captureSecret}`,
          },
          body: JSON.stringify({ page }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        res.status(r.ok ? 200 : 502).json(j);
      } catch {
        res
          .status(502)
          .json({ ok: false, message: "Service capture injoignable." });
      }
    }
  );

  // ── COCKPIT CHAT Eva (SSE, Ollama local) ─────────────────────────────────
  // Navigation-focused: Eva répond et peut inclure NAV:/route en fin de message
  // pour déclencher la navigation Selenium côté client. PHI-free.
  const SYSTEM_COCKPIT =
    "Tu es Eva, assistante IA du cockpit MediView (visionneuse radiologique DICOM). " +
    "Tu parles français, brièvement et précisément. " +
    "Tu aides le radiologue à naviguer dans l'interface et à trouver des infos en base de connaissances. " +
    "Pages disponibles : worklist (/), viewer DICOM (/viewer/<studyId>), base de connaissances (/admin/knowledge), recherche (/knowledge). " +
    "Si tu dois naviguer vers une page, ajoute EXACTEMENT à la toute fin de ta réponse : NAV:/route " +
    "Exemple : 'J'ouvre la worklist. NAV:/' " +
    "Ne mentionne jamais de données patient (PHI) dans tes réponses.";

  app.post(
    "/api/cockpit/chat/stream",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const body = req.body as Record<string, unknown>;
      const userMsgs = Array.isArray(body.messages)
        ? (body.messages as { role: string; content: string }[]).slice(-20)
        : null;
      if (!userMsgs || userMsgs.length === 0) {
        res.status(400).json({ error: "Bad request" });
        return;
      }
      const messages = [
        { role: "system", content: SYSTEM_COCKPIT },
        ...userMsgs.map(m => ({
          role: m.role,
          content: String(m.content ?? "").slice(0, 4_000),
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const send = (obj: unknown) =>
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const abortCtrl = new AbortController();
      req.on("close", () => abortCtrl.abort());

      try {
        const { streamOllamaChat } = await import("./knowledge/stream");
        const full = await streamOllamaChat(
          messages,
          (delta: string) => send({ t: delta }),
          abortCtrl.signal
        );
        const navMatch = full.match(/NAV:(\/[^\s]*)/);
        send({ done: true, nav: navMatch?.[1] ?? null });
        res.end();
      } catch {
        if (!res.headersSent) {
          res.status(500).json({ error: "stream failed" });
        } else {
          send({ error: "stream interrompu" });
          res.end();
        }
      }
    }
  );

  // ── VOIX SESSION (config pour le client WebSocket Vertex-UE) ─────────────
  app.post(
    "/api/voix/session",
    requireAuth,
    (_req: Request, res: Response): void => {
      const provider = (process.env.VOICE_PROVIDER ?? "").trim();
      const project = (process.env.VERTEX_PROJECT ?? "").trim();
      if (provider !== "vertex-ue" || !project) {
        res.status(503).json({ error: "Voix Vertex-UE non configurée." });
        return;
      }
      res.json({ wsUrl: "/api/voix/live-ue" });
    }
  );
}
