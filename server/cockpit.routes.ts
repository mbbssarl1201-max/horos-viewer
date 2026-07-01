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

function pageAutorisee(page: string): boolean {
  if (!page || !page.startsWith("/")) return false;
  const clean = page.split("?")[0]!.split("#")[0]!;
  // Toutes les routes internes MediView sont autorisées (Selenium reste sur notre propre app)
  return /^\/[a-zA-Z0-9/_-]*$/.test(clean);
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

  // novnc_proxy (Selenium) expose websockify à la racine, pas à /websockify
  const internalWsUrl = rawLiveUrl.replace(/^https?:\/\//, "wss://") + "/";

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

  // ── ACTIONS SELENIUM ─────────────────────────────────────────────────────
  // Proxy vers eva-capture-mediview : cliquer / taper / defiler.
  // Le corps est transmis tel quel après validation du type d'action.
  const ACTIONS_AUTORISEES = new Set(["cliquer", "taper", "defiler"]);

  app.post(
    "/api/cockpit/action",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      if (!captureUrl || !captureSecret) {
        res
          .status(503)
          .json({ ok: false, message: "Service capture non configuré." });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const type = typeof body.type === "string" ? body.type : "";
      if (!ACTIONS_AUTORISEES.has(type)) {
        res
          .status(400)
          .json({ ok: false, message: "Type action non autorisé." });
        return;
      }
      try {
        const r = await fetch(`${captureUrl}/${type}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${captureSecret}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
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
  const SYSTEM_COCKPIT_BASE = `Tu es Eva, radiologue IA senior intégrée dans MediView. Tu as une formation équivalente à un radiologue diplômé avec 10 ans d'expérience en imagerie diagnostique. Tu parles UNIQUEMENT en français, de façon concise et précise comme un médecin.

## TON EXPERTISE RADIOLOGIQUE

### Modalités et protocoles
- **TDM/CT** : fenêtrage HU (parenchyme pulmonaire −600/1600, médiastin 40/400, os 700/2000, cérébral 35/80, abdominal 60/350, foie 80/160), injection iodée phases : artérielle (25–35 s), portale (65–75 s), tardive (3–5 min). Scores coronariens (Agatston). CTDI, DLP.
- **IRM** : séquences T1 (graisse brillante, sang récent brillant), T2 (eau brillante, lésions brillantes), FLAIR (LCR supprimé), DWI/ADC (restriction eau = cellularité élevée), T1 Gado (rehaussement = rupture BHE ou hypervascularisation), spectro, perfusion, DTI.
- **Radiographie** : silhouette cardiaque (ICT normal <0,5), index de vascularisation pulmonaire, signe de la silhouette, infiltrats, épanchements.
- **Échographie** : anéchogène (liquide), hypoéchogène, hyperéchogène, artefacts (renforcement postérieur = liquide, cône d'ombre = calcification, réverbération).
- **Mammographie** : densité ACR (A/B/C/D), catégories BI-RADS 0–6, microcalcifications (morphologie, distribution), masses (forme, marges, densité).
- **Médecine nucléaire/PET** : SUVmax, captation pathologique, SUV>2,5 suspect, artefacts d'atténuation.

### Sémiologie et valeurs de référence
- Aorte : racine <3,7 cm, aorte descendante <2,5 cm. Anévrisme si >5 cm.
- Cardiomégalie : ICT >0,5 sur radio face.
- Nodule pulmonaire : Fleischner Society 2017 (solide <6 mm = pas de suivi si faible risque, 6–8 mm = TDM 6–12 mois, >8 mm = PET/biopsie). LungRADS.
- Foie : lobes D/G, veines sus-hépatiques, VBP <7 mm, HTP (splénomégalie, circulation collatérale, ascite). LI-RADS.
- Rein : cortex 15–18 mm, index cortico-médullaire, kyste simple Bosniak I/II/IIF/III/IV.
- Prostate : volume, zones (centrale/périphérique/transition), PI-RADS v2.1 (1–5).
- Thyroïde : EU-TIRADS 1–5, volume, vascularisation Doppler.
- Rachis : spondylolisthésis (grades Meyerding), hernies discales (protrusion/extrusion/séquestration), sténoses foraminales/canalaires.
- Cerveau : œdème vasogénique (T2 blanc, DWI libre), AVC ischémique (DWI restreint, ADC bas), hémorragie (hyperdensité CT aigu, T1 brillant subaigu).

### Diagnostics différentiels par pattern
- Opacité alvéolaire bilatérale : OAP, pneumonie, hémorragie, SDRA.
- Masse hépatique solitaire : HCC, métastase, hémangiome, CHC, adénome, FNH.
- Lésion kystique ovarienne : kyste fonctionnel, endométriome, cystadénome, tératome mature, cancer.
- Adénopathie médiastinale : lymphome, sarcoïdose, métastases, tuberculose.
- Masse rénale solide : CCR (clear cell/papillaire/chromophobe), angiomyolipome, oncocytome, métastase.

### Systèmes de scoring (mémoriser les seuils)
- BI-RADS : 0 incomplet, 1 normal, 2 bénin, 3 probablement bénin (<2%), 4A faible suspicion (2–10%), 4B intermédiaire (10–50%), 4C haute suspicion (50–95%), 5 malin (>95%), 6 prouvé.
- PI-RADS : 1–2 pas de cancer significatif, 3 équivoque, 4–5 suspect (cancer significatif probable/très probable).
- LI-RADS : LR-1 définitivement bénin, LR-2 probablement bénin, LR-3 intermédiaire, LR-4 probablement HCC, LR-5 définitivement HCC, LR-M suspect malin non HCC, LR-TIV thrombose tumorale.
- ASPECT score (AVC) : 0–10 (≤7 = infarctus étendu, mauvais pronostic thrombolyse).
- Fleischner solide : <6 mm → pas de suivi (risque faible) ; 6–8 mm → 6–12 mois ; >8 mm → 3 mois ou PET ou biopsie.

## PILOTAGE DE L'APPLICATION

### Pages
/ → Worklist principale
/viewer/<id> → Viewer DICOM (id = entier)
/admin/knowledge → Base de connaissances
/knowledge → Recherche KB

### Albums (clés exactes)
database → tout
recent_hour → Just Acquired
added_hour → Just Added
opened → Just Opened

### Commandes (en fin de réponse, une par ligne)
NAV:/route → naviguer vers une page
CMD:album:clé → sélectionner album
CMD:search:termes → rechercher dans la worklist
CMD:generer-cr:<studyId> → générer un compte rendu IA pour l'étude (studyId = entier)
CMD:envoyer-rapport:<studyId>:<email> → envoyer le CR IA de l'étude par email

### Exemples
"J'ouvre la worklist." → NAV:/
"Je filtre CT du jour." → CMD:album:recent_hour
"Recherche IRM genou." → CMD:search:IRM genou
"J'ouvre l'étude 42." → NAV:/viewer/42
"Je génère le CR de l'étude 7." → CMD:generer-cr:7
"J'envoie le rapport de l'étude 7 à dr.martin@hopital.ch" → CMD:envoyer-rapport:7:dr.martin@hopital.ch

PHI INTERDIT : jamais de nom/prénom/DDN patient.`;

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
        // Gemini via Vertex AI europe-west1 — même backend que la voix Eva (nLPD ✓)
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({
          vertexai: true,
          project: process.env.VERTEX_PROJECT ?? "optigps",
          location: process.env.VERTEX_LOCATION ?? "europe-west1",
        });
        // gemini-2.5-flash = seul modèle de texte disponible dans europe-west1 sur ce projet
        const textModel =
          process.env.GEMINI_TEXT_MODEL ??
          process.env.GEMINI_VERTEX_MODEL ??
          "gemini-2.5-flash";
        const sysMsg = messages.find(m => m.role === "system")?.content ?? "";
        const contents = messages
          .filter(m => m.role !== "system")
          .map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }));
        let full = "";
        const stream = await ai.models.generateContentStream({
          model: textModel,
          contents,
          config: {
            systemInstruction: sysMsg,
            maxOutputTokens: 1200,
            temperature: 0.2,
          },
        });
        for await (const chunk of stream) {
          if (abortCtrl.signal.aborted) break;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c = chunk as any;
          const txt = (c.candidates?.[0]?.content?.parts ?? [])
            .map((p: any) => p.text ?? "")
            .join("");
          if (txt) {
            send({ t: txt });
            full += txt;
          }
        }
        // Extraire toutes les commandes Eva de la réponse
        const navMatch = full.match(/NAV:(\/[^\s\n]*)/);
        const albumMatch = full.match(/CMD:album:([^\s\n]+)/);
        const searchMatch = full.match(/CMD:search:([^\n]+)/);
        const crMatch = full.match(/CMD:generer-cr:(\d+)/);
        const mailMatch = full.match(/CMD:envoyer-rapport:(\d+):([^\s\n]+)/);
        const cmds: Array<{ type: string; payload: string }> = [];
        if (navMatch) cmds.push({ type: "nav", payload: navMatch[1] });
        if (albumMatch)
          cmds.push({ type: "album", payload: albumMatch[1].trim() });
        if (searchMatch)
          cmds.push({ type: "search", payload: searchMatch[1].trim() });
        if (crMatch) cmds.push({ type: "generer-cr", payload: crMatch[1] });
        if (mailMatch)
          cmds.push({
            type: "envoyer-rapport",
            payload: `${mailMatch[1]}:${mailMatch[2].trim()}`,
          });
        send({ done: true, nav: navMatch?.[1] ?? null, cmds });
        res.end();
      } catch (err) {
        console.error("[Eva cockpit chat]", String(err));
        if (!res.headersSent) {
          res.status(500).json({ error: "stream failed" });
        } else {
          send({ error: "stream interrompu" });
          res.end();
        }
      }
    }
  );

  // helper — escape HTML pour les champs DB interpolés dans les emails
  const escHtml = (s: string) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // helper — génère un CR IA pour une étude (réutilisé par les deux endpoints)
  async function genererCrTexte(studyId: number): Promise<string> {
    const { getStudyById, getReportByStudy } = await import("./db");
    const study = await getStudyById(studyId);
    if (!study) throw new Error("Étude introuvable");
    const report = await getReportByStudy(studyId);
    const { buildHermesContext } = await import("./report/hermesChat");
    const studyCtx = buildHermesContext(study as any, report as any);
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.VERTEX_PROJECT ?? "optigps",
      location: process.env.VERTEX_LOCATION ?? "europe-west1",
    });
    const prompt =
      `Tu es Eva, radiologue IA senior. Génère un compte rendu radiologique structuré en français. ` +
      `Format : Indication, Technique, Résultats (par système), Conclusion, Recommandations. ` +
      `PHI INTERDIT : jamais de nom/prénom/DDN patient.\n\nContexte étude :\n${studyCtx}\n\n` +
      `Texte actuel du CR :\n${(report as any)?.content ?? "(aucun)"}`;
    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 2000, temperature: 0.15 },
    });
    let crText = "";
    for await (const chunk of stream) {
      const c = chunk as any;
      crText += (c.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "")
        .join("");
    }
    return crText.trim();
  }

  // ── GÉNÉRER COMPTE RENDU IA ───────────────────────────────────────────────
  // POST /api/cockpit/generer-cr  { studyId: number }
  // Réservé aux radiologistes et admins (gate par rôle, pas seulement auth).
  app.post(
    "/api/cockpit/generer-cr",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const user = (req as any).user as { role?: string } | undefined;
      if (!user?.role || !["admin", "radiologist"].includes(user.role)) {
        res
          .status(403)
          .json({ ok: false, error: "Accès réservé aux radiologistes" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const studyId = Number(body.studyId);
      if (!studyId || isNaN(studyId)) {
        res.status(400).json({ ok: false, error: "studyId requis" });
        return;
      }
      try {
        const crText = await genererCrTexte(studyId);
        res.json({ ok: true, studyId, text: crText });
      } catch (err) {
        console.error("[Eva generer-cr]", String(err));
        res.status(500).json({ ok: false, error: "Génération échouée" });
      }
    }
  );

  // ── ENVOYER RAPPORT PAR EMAIL ─────────────────────────────────────────────
  // POST /api/cockpit/envoyer-rapport  { studyId, to }
  // Le contenu est généré serveur-side (pas de client contenu pour éviter l'injection).
  // Réservé aux radiologistes et admins.
  app.post(
    "/api/cockpit/envoyer-rapport",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const user = (req as any).user as { role?: string } | undefined;
      if (!user?.role || !["admin", "radiologist"].includes(user.role)) {
        res
          .status(403)
          .json({ ok: false, error: "Accès réservé aux radiologistes" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const studyId = Number(body.studyId);
      const to = typeof body.to === "string" ? body.to.trim() : "";
      if (!studyId || isNaN(studyId) || !to || !to.includes("@")) {
        res
          .status(400)
          .json({ ok: false, error: "studyId et to (email) requis" });
        return;
      }
      try {
        const { isAllowedRecipient } = await import("./_core/emailAllowList");
        const { ENV } = await import("./_core/env");
        if (!isAllowedRecipient(to, ENV.reportEmailAllowedDomains)) {
          res
            .status(403)
            .json({ ok: false, error: "Destinataire non autorisé" });
          return;
        }
        const { getStudyById } = await import("./db");
        const study = await getStudyById(studyId);
        if (!study) {
          res.status(404).json({ ok: false, error: "Étude introuvable" });
          return;
        }
        // Le contenu vient du générateur serveur — jamais du client (anti-injection).
        const crText = await genererCrTexte(studyId);
        const s = study as any;
        const desc = s.studyDescription || s.modality || "Examen";
        const date = s.studyDate ?? "";
        // Tous les champs DB sont escapés avant interpolation HTML.
        const htmlContenu = escHtml(crText).replace(/\n/g, "<br>");
        const html = `<div style="font-family:sans-serif;max-width:700px">
<h2 style="color:#1a4d7a">Compte rendu IA — ${escHtml(desc)}</h2>
<p style="color:#555">Date : ${escHtml(date)} &nbsp;|&nbsp; ID étude : ${studyId}</p>
<hr style="border:1px solid #ddd;margin:16px 0">
<div style="line-height:1.7">${htmlContenu}</div>
<hr style="border:1px solid #ddd;margin:16px 0">
<p style="color:#888;font-size:12px">⚠️ Ce compte rendu est généré par une IA et doit être relu et validé par un radiologue qualifié avant tout usage clinique.</p>
</div>`;
        const { sendEmail } = await import("./email");
        const result = await sendEmail({
          to,
          subject: `CR IA — ${escHtml(desc)} (ID ${studyId})`,
          html,
        });
        res.json(result);
      } catch (err) {
        console.error("[Eva envoyer-rapport]", String(err));
        res.status(500).json({ ok: false, error: "Envoi échoué" });
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
