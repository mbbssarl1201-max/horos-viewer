// server/cockpit.routes.ts
//
// Routes API du COCKPIT Eva-Selenium (MediView) :
//   GET  /api/cockpit/viewer   → page HTML noVNC (même-origine, auth requise)
//   POST /api/cockpit/naviguer → proxy vers eva-capture-mediview
//   WS   /api/cockpit/vnc-ws  → proxy WS vers le conteneur VNC interne
//
// Sécurité : pages restreintes à un jeu fermé (anti open-redirect) ;
// Le proxy complète lui-même l'auth RFB VNC avec le serveur upstream et présente
// au navigateur un tunnel sans authentification (security type 1 = None).
// Les messages d'entrée RFB (types 4/5/6) sont filtrés côté serveur (view-only réel).
import type { Express, Request, Response, NextFunction } from "express";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createCipheriv } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { sdk } from "./_core/sdk";

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

// Le HTML noVNC se connecte au proxy WS du même serveur (/api/cockpit/vnc-ws).
// Le proxy gère lui-même l'auth RFB, donc le navigateur reçoit un tunnel No-Auth —
// aucun secret VNC n'est transmis au client.
function buildViewerHtml(): string {
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
  const wsUrl = location.origin.replace(/^http/, 'ws') + '/api/cockpit/vnc-ws';
  const rfb = new RFB(document.getElementById('screen'), wsUrl);
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

// ── Helpers RFB ──────────────────────────────────────────────────────────────

// VNC DES challenge-response : DES-ECB avec clé dont les bits de chaque octet
// sont inversés (contrairement au DES standard). RFC-VNC §6.2.2.
function vncDESResponse(password: string, challenge: Buffer): Buffer {
  const raw = Buffer.from(password.substring(0, 8).padEnd(8, "\0"), "latin1");
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    let b = raw[i] ?? 0;
    let r = 0;
    for (let j = 0; j < 8; j++) {
      r = (r << 1) | (b & 1);
      b >>>= 1;
    }
    key[i] = r;
  }
  const enc = (block: Buffer): Buffer => {
    const c = createCipheriv("des-ecb", key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block), c.final()]);
  };
  return Buffer.concat([
    enc(challenge.subarray(0, 8)),
    enc(challenge.subarray(8)),
  ]);
}

interface UpstreamAuthResult {
  serverInit: Buffer;
  remaining: Buffer;
}

// Complète l'auth RFB 3.8 VNC avec le serveur upstream (websockify→VNC).
// Résout avec { serverInit, remaining } une fois l'auth réussie.
function rfbAuthUpstream(
  upWs: WebSocket,
  password: string
): Promise<UpstreamAuthResult> {
  return new Promise<UpstreamAuthResult>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    // 0=version 1=security 2=challenge 3=auth_result 4=server_init
    let state = 0;

    const tid = setTimeout(() => {
      cleanup();
      upWs.close();
      reject(new Error("RFB upstream auth timeout"));
    }, 15_000);

    function cleanup(): void {
      clearTimeout(tid);
      upWs.removeListener("message", onMsg);
      upWs.removeListener("error", onErr);
      upWs.removeListener("close", onClose);
    }
    function onErr(): void {
      cleanup();
      reject(new Error("Upstream WS error during auth"));
    }
    function onClose(): void {
      cleanup();
      reject(new Error("Upstream WS closed during auth"));
    }
    function onMsg(data: Buffer | ArrayBuffer): void {
      buf = Buffer.concat([
        buf,
        Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
      ]);
      process();
    }

    function process(): void {
      try {
        for (;;) {
          if (state === 0) {
            // Await 12-byte version greeting
            if (buf.length < 12) return;
            buf = buf.subarray(12);
            upWs.send(Buffer.from("RFB 003.008\n", "ascii"));
            state = 1;
          } else if (state === 1) {
            // Await security-type list
            if (buf.length < 1) return;
            const n = buf[0]!;
            if (buf.length < 1 + n) return;
            const types = buf.subarray(1, 1 + n);
            if (!types.includes(2)) {
              cleanup();
              reject(new Error("VNC server does not offer VNC Auth (type 2)"));
              return;
            }
            upWs.send(Buffer.from([2])); // choose VNC Auth
            buf = buf.subarray(1 + n);
            state = 2;
          } else if (state === 2) {
            // Await 16-byte DES challenge
            if (buf.length < 16) return;
            const response = vncDESResponse(password, buf.subarray(0, 16));
            upWs.send(response);
            buf = buf.subarray(16);
            state = 3;
          } else if (state === 3) {
            // Await 4-byte security result
            if (buf.length < 4) return;
            const ok = buf.readUInt32BE(0) === 0;
            buf = buf.subarray(4);
            if (!ok) {
              cleanup();
              reject(new Error("VNC auth failed (bad password)"));
              return;
            }
            upWs.send(Buffer.from([1])); // ClientInit shared=1
            state = 4;
          } else if (state === 4) {
            // Await ServerInit: 24-byte header + name
            if (buf.length < 24) return;
            const nameLen = buf.readUInt32BE(20);
            const total = 24 + nameLen;
            if (buf.length < total) return;
            const serverInit = Buffer.from(buf.subarray(0, total));
            const remaining = Buffer.from(buf.subarray(total));
            cleanup();
            resolve({ serverInit, remaining });
            return;
          }
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    }

    upWs.on("message", onMsg);
    upWs.on("error", onErr);
    upWs.on("close", onClose);
  });
}

// Exécute le handshake No-Auth RFB 3.8 côté navigateur.
// Résout quand ClientInit a été reçu (navigateur prêt pour l'opération normale).
function rfbNoAuthBrowser(brWs: WebSocket, serverInit: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    // 0=await_version 1=await_security_choice 2=await_client_init
    let state = 0;

    const tid = setTimeout(() => {
      cleanup();
      reject(new Error("Browser RFB handshake timeout"));
    }, 15_000);

    function cleanup(): void {
      clearTimeout(tid);
      brWs.removeListener("message", onMsg);
      brWs.removeListener("error", onErr);
      brWs.removeListener("close", onClose);
    }
    function onErr(): void {
      cleanup();
      reject(new Error("Browser WS error during handshake"));
    }
    function onClose(): void {
      cleanup();
      reject(new Error("Browser WS closed during handshake"));
    }
    function onMsg(data: Buffer | ArrayBuffer): void {
      buf = Buffer.concat([
        buf,
        Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
      ]);
      process();
    }

    function process(): void {
      try {
        for (;;) {
          if (state === 0) {
            // Await 12-byte version from browser
            if (buf.length < 12) return;
            buf = buf.subarray(12);
            // Offer only security type 1 (None) — proxy handled the real auth
            brWs.send(Buffer.from([0x01, 0x01]));
            state = 1;
          } else if (state === 1) {
            // Await 1-byte security type choice (browser picks 1 = None)
            if (buf.length < 1) return;
            buf = buf.subarray(1);
            // Send security result OK
            brWs.send(Buffer.from([0x00, 0x00, 0x00, 0x00]));
            state = 2;
          } else if (state === 2) {
            // Await 1-byte ClientInit
            if (buf.length < 1) return;
            buf = buf.subarray(1);
            // Send ServerInit captured from upstream
            brWs.send(serverInit, { binary: true });
            cleanup();
            resolve();
            return;
          }
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    }

    // Send version greeting to browser first
    brWs.send(Buffer.from("RFB 003.008\n", "ascii"));
    brWs.on("message", onMsg);
    brWs.on("error", onErr);
    brWs.on("close", onClose);
  });
}

// Filtre les messages RFB client→serveur : transmet SetPixelFormat (0),
// SetEncodings (2), FramebufferUpdateRequest (3) ; bloque KeyEvent (4),
// PointerEvent (5), ClientCutText (6). Retourne le reste non consommé.
function rfbRelayFiltered(buf: Buffer, upWs: WebSocket): Buffer {
  let offset = 0;
  while (offset < buf.length) {
    const msgType = buf[offset];
    let msgLen: number;

    if (msgType === 0) {
      msgLen = 20; // SetPixelFormat: 4 header + 16 PIXEL_FORMAT
    } else if (msgType === 2) {
      // SetEncodings: 1 type + 1 pad + 2 count + count*4
      if (offset + 4 > buf.length) break;
      const count = buf.readUInt16BE(offset + 2);
      msgLen = 4 + count * 4;
    } else if (msgType === 3) {
      msgLen = 10; // FramebufferUpdateRequest
    } else if (msgType === 4) {
      msgLen = 8; // KeyEvent — DROP
    } else if (msgType === 5) {
      msgLen = 6; // PointerEvent — DROP
    } else if (msgType === 6) {
      // ClientCutText: 1 type + 3 pad + 4 len + text
      if (offset + 8 > buf.length) break;
      msgLen = 8 + buf.readUInt32BE(offset + 4);
    } else {
      // Unknown type: skip 1 byte to avoid stall
      offset += 1;
      continue;
    }

    if (offset + msgLen > buf.length) break; // partial — wait for more

    // Forward display-control messages only; silently drop input types
    if (msgType !== 4 && msgType !== 5 && msgType !== 6) {
      if (upWs.readyState === WebSocket.OPEN) {
        upWs.send(buf.subarray(offset, offset + msgLen), { binary: true });
      }
    }
    offset += msgLen;
  }
  return Buffer.from(buf.subarray(offset));
}

const VNC_PROXY_PATH = "/api/cockpit/vnc-ws";

// Proxy WebSocket : navigateur → /api/cockpit/vnc-ws → conteneur VNC interne.
//
// Stratégie auth : le proxy complète lui-même l'auth RFB VNC avec l'upstream
// (DES challenge-response), puis présente au navigateur un tunnel No-Auth
// (security type 1 = None). Ainsi TOUS les messages du navigateur sont
// post-handshake par construction — aucun chemin de bypass possible pour les
// types d'entrée (4/5/6), filtrés inconditionnellement par rfbRelayFiltered.
//
// Doit être appelé depuis _core/index.ts après registerCockpitRoutes(app).
export function attacherVncProxy(server: Server): void {
  const rawLiveUrl = (process.env.EVA_LIVE_URL ?? "").replace(/\/$/, "");
  const vncPassword = process.env.EVA_VNC_PASSWORD ?? "";
  if (!rawLiveUrl || !vncPassword) return;

  // URL interne Docker — le navigateur ne peut pas l'atteindre directement.
  const internalWsUrl =
    rawLiveUrl.replace(/^https?:\/\//, "ws://") + "/websockify";

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== VNC_PROXY_PATH) return;

    // CSWSH : Origin obligatoire et doit correspondre au même hôte.
    const origin = req.headers.origin ?? "";
    const host = req.headers.host ?? "";
    if (
      !origin ||
      (origin !== `https://${host}` && origin !== `http://${host}`)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    sdk
      .authenticateRequest(req as never)
      .then(async user => {
        const { hasMedicalAccess } = await import("./rbac");
        if (!hasMedicalAccess(user)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        // Étape 1 : connexion upstream + auth RFB AVANT d'accepter le navigateur.
        const upWs = new WebSocket(internalWsUrl, ["binary"]);
        upWs.binaryType = "nodebuffer";

        const connectTimeout = setTimeout(() => {
          upWs.close();
          socket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
          socket.destroy();
        }, 15_000);

        const onUpstreamOpenError = (err?: unknown): void => {
          if (err) {
            clearTimeout(connectTimeout);
            socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            socket.destroy();
          }
        };
        upWs.once("error", onUpstreamOpenError);

        upWs.once("open", () => {
          upWs.removeListener("error", onUpstreamOpenError);

          rfbAuthUpstream(upWs, vncPassword)
            .then(({ serverInit, remaining }) => {
              clearTimeout(connectTimeout);

              // Buffer upstream frames arriving while browser handshake runs.
              let branchDone = false;
              let browserWs: WebSocket | null = null;
              const upstreamQueue: Buffer[] = [];
              if (remaining.length > 0) upstreamQueue.push(remaining);

              upWs.on("message", (data: Buffer | ArrayBuffer) => {
                const chunk = Buffer.isBuffer(data)
                  ? data
                  : Buffer.from(data as ArrayBuffer);
                if (branchDone && browserWs?.readyState === WebSocket.OPEN) {
                  browserWs.send(chunk, { binary: true });
                } else {
                  upstreamQueue.push(chunk);
                }
              });
              upWs.on("close", () => {
                if (browserWs?.readyState === WebSocket.OPEN) browserWs.close();
              });
              upWs.on("error", () => {
                if (browserWs?.readyState === WebSocket.OPEN) browserWs.close();
              });

              // Étape 2 : accepter le navigateur et exécuter le handshake No-Auth.
              wss.handleUpgrade(req, socket, head, ws => {
                browserWs = ws;

                rfbNoAuthBrowser(ws, serverInit)
                  .then(() => {
                    branchDone = true;

                    // Vider la file upstream accumulée.
                    for (const chunk of upstreamQueue) {
                      if (ws.readyState === WebSocket.OPEN)
                        ws.send(chunk, { binary: true });
                    }
                    upstreamQueue.length = 0;

                    // Relay navigateur→upstream avec filtrage RFB input.
                    let brBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
                    ws.on("message", (data: Buffer | ArrayBuffer) => {
                      const chunk = Buffer.isBuffer(data)
                        ? data
                        : Buffer.from(data as ArrayBuffer);
                      brBuf = Buffer.concat([brBuf, chunk]);
                      brBuf = rfbRelayFiltered(brBuf, upWs);
                    });

                    ws.on("close", () => upWs.close());
                    ws.on("error", () => upWs.close());
                  })
                  .catch(() => {
                    ws.close();
                    upWs.close();
                  });
              });
            })
            .catch(() => {
              clearTimeout(connectTimeout);
              socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
              socket.destroy();
            });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      });
  });

  console.log(
    `[VncProxy-Cockpit] Proxy WS ${VNC_PROXY_PATH} actif → ${internalWsUrl}`
  );
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

  app.get(
    "/api/cockpit/viewer",
    requireAuth,
    (_req: Request, res: Response): void => {
      if (!rawLiveUrl || !vncPassword) {
        res.status(503).send("Service navigateur live non configuré.");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Cache-Control", "no-store");
      res.send(buildViewerHtml()); // le proxy gère l'auth VNC, pas le client
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

  // ── ÉTUDES RÉCENTES (PHI-safe : sans nom patient) ────────────────────────
  // Utilisé par le chat Eva (contexte) et le tool vocal chercherEtudes.
  app.get(
    "/api/cockpit/studies/recent",
    requireAuth,
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const { listStudies } = await import("./db");
        const rows = await listStudies({ timeFilter: "last_week" });
        const safe = rows.slice(0, 15).map(s => ({
          id: s.id,
          studyDate: s.studyDate,
          studyDescription:
            s.studyDescription ||
            [s.modality, s.studyDate].filter(Boolean).join(" — ") ||
            "Examen",
          modality: s.modality,
          numberOfSeries: s.numberOfSeries,
          numberOfInstances: s.numberOfInstances,
          status: s.status,
        }));
        res.json(safe);
      } catch {
        res.json([]);
      }
    }
  );

  // ── COCKPIT CHAT Eva (SSE, Ollama local) ─────────────────────────────────
  // Navigation-focused: Eva répond et peut inclure NAV:/route en fin de message
  // pour déclencher la navigation Selenium côté client. PHI-free.
  const SYSTEM_COCKPIT_BASE =
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

      // Injecte les études récentes dans le contexte (sans PHI : pas de patientName)
      let studiesCtx = "";
      try {
        const { listStudies } = await import("./db");
        const rows = await listStudies({ timeFilter: "last_week" });
        if (rows.length > 0) {
          const lines = rows
            .slice(0, 10)
            .map(
              s =>
                `  - ID ${s.id} : ${s.studyDescription ?? s.modality ?? "?"} (${s.modality ?? "?"}), ${s.studyDate ?? "?"}, ${s.numberOfSeries ?? 0} série(s) → /viewer/${s.id}`
            );
          studiesCtx =
            "\n\nÉtudes disponibles cette semaine (sans données patient) :\n" +
            lines.join("\n") +
            "\nPour ouvrir une étude : NAV:/viewer/<id>.";
        }
      } catch {
        /* contexte études non critique */
      }

      const messages = [
        { role: "system", content: SYSTEM_COCKPIT_BASE + studiesCtx },
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
