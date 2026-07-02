// server/voix/vertexLiveProxy.ts
// Proxy WebSocket Vertex AI (europe-west1) pour la voix Eva dans MediView.
// Architecture identique à medicentral : navigateur → WS VPS CH → Vertex UE.
// Le serveur relaie l'audio bidirectionnel ; les tool-calls (naviguer) sont
// renvoyés au navigateur qui exécute la navigation Selenium côté client.
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
} from "@google/genai";
import { sdk } from "../_core/sdk";
import { construireSessionGeminiLive } from "./geminiLive";

const PATH = "/api/voix/live-ue";
const trim = (s?: string) => (s ?? "").trim();

export function vertexUeVoixActif(): boolean {
  return (
    trim(process.env.VOICE_PROVIDER) === "vertex-ue" &&
    !!trim(process.env.VERTEX_PROJECT)
  );
}

export const PROXY_VOIX_PATH = PATH;

function vertexVoixRegion(): string {
  return (
    trim(process.env.VOICE_VERTEX_REGION) ||
    trim(process.env.VERTEX_LOCATION) ||
    "europe-west1"
  );
}
function vertexVoixModele(): string {
  return (
    trim(process.env.VOICE_VERTEX_MODEL) ||
    "gemini-live-2.5-flash-preview-native-audio"
  );
}

function envoyer(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket fermé entre-temps */
    }
  }
}

export function attacherProxyVoixVertex(server: Server): void {
  if (!vertexUeVoixActif()) return;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try {
      pathname = new URL(req.url || "", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== PATH) return;
    sdk
      .authenticateRequest(req as never)
      .then(user => {
        wss.handleUpgrade(req, socket, head, ws => {
          void gererConnexion(ws, user);
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      });
  });

  console.log(
    `[VoixVertex-MV] Proxy WS ${PATH} actif (région ${vertexVoixRegion()}, modèle ${vertexVoixModele()})`
  );
}

async function gererConnexion(ws: WebSocket, _user: unknown): Promise<void> {
  const cfg = construireSessionGeminiLive();
  const ai = new GoogleGenAI({
    vertexai: true,
    project: trim(process.env.VERTEX_PROJECT),
    location: vertexVoixRegion(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any = null;

  try {
    session = await ai.live.connect({
      model: vertexVoixModele(),
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: cfg.systemInstruction,
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 20,
            silenceDurationMs:
              Number(trim(process.env.VOICE_SILENCE_MS)) || 400,
          },
        },
        tools: [
          {
            functionDeclarations: (
              cfg.tools as Array<Record<string, unknown>>
            ).map(t => ({
              name: t.name as string,
              description: t.description as string,
              parameters: t.parameters as Record<string, unknown>,
            })),
          },
        ],
      },
      callbacks: {
        onopen: () => envoyer(ws, { type: "open" }),
        onmessage: (msg: unknown) => envoyer(ws, { type: "message", msg }),
        onerror: (e: unknown) =>
          envoyer(ws, {
            type: "error",
            error: String((e as Error)?.message || e),
          }),
        onclose: () => {
          try {
            ws.close();
          } catch {
            /* */
          }
        },
      },
    });
  } catch (e) {
    envoyer(ws, { type: "error", error: String((e as Error)?.message || e) });
    try {
      ws.close();
    } catch {
      /* */
    }
    return;
  }

  ws.on("message", (raw: unknown) => {
    let m: {
      type?: string;
      data?: string;
      mimeType?: string;
      functionResponses?: unknown[];
    };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      if (m.type === "audio" && m.data) {
        session?.sendRealtimeInput({
          media: {
            data: m.data,
            mimeType: m.mimeType || "audio/pcm;rate=16000",
          },
        });
      } else if (
        m.type === "toolResponse" &&
        Array.isArray(m.functionResponses)
      ) {
        session?.sendToolResponse({ functionResponses: m.functionResponses });
      }
    } catch {
      /* relais best-effort */
    }
  });

  const fermer = () => {
    try {
      session?.close();
    } catch {
      /* */
    }
  };
  ws.on("close", fermer);
  ws.on("error", fermer);
}
