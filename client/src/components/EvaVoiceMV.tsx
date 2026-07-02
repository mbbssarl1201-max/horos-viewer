// client/src/components/EvaVoiceMV.tsx
// Bouton voix Eva pour MediView Cockpit.
// Connexion WS → Vertex AI europe-west1 via proxy VPS.
// Les tool-calls "naviguer" déclenchent POST /api/cockpit/naviguer.
// PHI-safe : seul l'audio micro est transmis, jamais de données patient.
import { useState, useRef, useCallback, useEffect } from "react";
import { AlertCircle, Mic, Phone } from "lucide-react";

type Etat = "inactif" | "connexion" | "actif" | "erreur";

interface Props {
  onNavigation?: (route: string) => void;
}

// AudioWorklet inline : capture PCM16 à 16 kHz
const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch?.length) return true;
    const buf = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++)
      buf[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
    this.port.postMessage(buf.buffer, [buf.buffer]);
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export default function EvaVoiceMV({ onNavigation }: Props) {
  const [etat, setEtat] = useState<Etat>("inactif");
  const [erreur, setErreur] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const queueRef = useRef<AudioBuffer[]>([]);
  const playingRef = useRef(false);

  const arreter = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    queueRef.current = [];
    playingRef.current = false;
    setEtat("inactif");
  }, []);

  const jouerPcm = useCallback((b64: string) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    try {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const i16 = new Int16Array(bytes.buffer);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i]! / 32768;
      const buf = ctx.createBuffer(1, f32.length, 24000);
      buf.copyToChannel(f32, 0);
      queueRef.current.push(buf);
      if (playingRef.current) return;
      playingRef.current = true;
      const next = () => {
        const b = queueRef.current.shift();
        if (!b || !wsRef.current) {
          playingRef.current = false;
          return;
        }
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(ctx.destination);
        src.onended = next;
        src.start();
      };
      next();
    } catch {
      // audio parsing best-effort
    }
  }, []);

  const demarrer = useCallback(async () => {
    setEtat("connexion");
    setErreur(null);
    try {
      // 1. Vérifier config serveur
      const r = await fetch("/api/voix/session", { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Voix non disponible.");
      }
      const { wsUrl } = (await r.json()) as { wsUrl: string };

      // 2. AudioContext 16 kHz + worklet PCM capture
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      const blob = new Blob([WORKLET], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      // 3. Microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const worklet = new AudioWorkletNode(ctx, "pcm-capture");
      workletRef.current = worklet;
      source.connect(worklet);

      // 4. WebSocket vers proxy Vertex-UE
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${wsUrl}`);
      wsRef.current = ws;

      ws.onopen = () => setEtat("actif");
      ws.onerror = () => {
        setErreur("WebSocket perdu.");
        arreter();
      };
      ws.onclose = () => {
        if (wsRef.current) arreter();
      };

      ws.onmessage = (e: MessageEvent) => {
        void (async () => {
          try {
            const pkg = JSON.parse(e.data as string) as {
              type: string;
              msg?: unknown;
              error?: string;
            };
            if (pkg.type === "error") {
              setErreur(pkg.error ?? "Erreur voix");
              setEtat("erreur");
              return;
            }
            if (pkg.type !== "message" || !pkg.msg) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = pkg.msg as any;

            // Audio PCM 24 kHz
            const parts = msg?.serverContent?.modelTurn?.parts as
              | unknown[]
              | undefined;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const p = part as any;
                if (
                  p?.inlineData?.data &&
                  String(p.inlineData.mimeType ?? "").includes("audio")
                ) {
                  jouerPcm(p.inlineData.data as string);
                }
              }
            }

            // Tool-calls
            const fcs = msg?.toolCall?.functionCalls as
              | Array<{
                  id: string;
                  name: string;
                  args: Record<string, unknown>;
                }>
              | undefined;
            if (fcs?.length) {
              const responses: Array<{
                id: string;
                name: string;
                response: unknown;
              }> = [];
              for (const fc of fcs) {
                if (fc.name === "naviguer") {
                  const route = String(fc.args.route ?? "/");
                  void fetch("/api/cockpit/naviguer", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ page: route }),
                  });
                  onNavigation?.(route);
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { output: "OK: " + route },
                  });
                } else if (fc.name === "chercherEtudes") {
                  try {
                    const r = await fetch("/api/cockpit/studies/recent");
                    const data = (await r.json()) as Array<{
                      id: number;
                      studyDate?: string;
                      modality?: string;
                      studyDescription?: string;
                      numberOfSeries?: number;
                    }>;
                    const summary =
                      data.length === 0
                        ? "Aucune étude récente."
                        : data
                            .map(
                              s =>
                                `ID ${s.id}: ${s.studyDescription ?? s.modality ?? "?"} (${s.modality ?? "?"}), ${s.studyDate ?? "?"}, ${s.numberOfSeries ?? 0} série(s)`
                            )
                            .join("; ");
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: { output: summary },
                    });
                  } catch {
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: {
                        output: "Erreur lors de la récupération des études.",
                      },
                    });
                  }
                } else if (fc.name === "selectAlbum") {
                  const album = String(fc.args.album ?? "database");
                  window.dispatchEvent(
                    new CustomEvent("eva:selectAlbum", { detail: album })
                  );
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { output: "Album sélectionné : " + album },
                  });
                } else if (fc.name === "searchWorklist") {
                  const query = String(fc.args.query ?? "");
                  window.dispatchEvent(
                    new CustomEvent("eva:search", { detail: query })
                  );
                  responses.push({
                    id: fc.id,
                    name: fc.name,
                    response: { output: "Recherche lancée : " + query },
                  });
                } else if (fc.name === "genererCompteRendu") {
                  const studyId = Number(fc.args.studyId);
                  try {
                    const r = await fetch("/api/cockpit/generer-cr", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ studyId }),
                    });
                    const d = (await r.json()) as {
                      ok: boolean;
                      text?: string;
                      error?: string;
                    };
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: {
                        output: d.ok
                          ? `Compte rendu généré pour l'étude ${studyId}. Résumé : ${(d.text ?? "").slice(0, 300)}…`
                          : `Erreur : ${d.error}`,
                      },
                    });
                  } catch {
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: { output: "Génération du CR échouée." },
                    });
                  }
                } else if (fc.name === "envoyerRapport") {
                  const studyId = Number(fc.args.studyId);
                  const email = String(fc.args.emailDestinataire ?? "");
                  try {
                    const r = await fetch("/api/cockpit/envoyer-rapport", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ studyId, to: email, contenu: "" }),
                    });
                    const d = (await r.json()) as {
                      success: boolean;
                      error?: string;
                    };
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: {
                        output: d.success
                          ? `Rapport de l'étude ${studyId} envoyé à ${email}.`
                          : `Échec d'envoi : ${d.error}`,
                      },
                    });
                  } catch {
                    responses.push({
                      id: fc.id,
                      name: fc.name,
                      response: { output: "Envoi du rapport échoué." },
                    });
                  }
                }
              }
              if (responses.length)
                ws.send(
                  JSON.stringify({
                    type: "toolResponse",
                    functionResponses: responses,
                  })
                );
            }
          } catch {
            /* parse best-effort */
          }
        })();
      };

      // 5. Envoi micro → WS
      worklet.port.onmessage = (ev: MessageEvent) => {
        if (ws.readyState !== ws.OPEN) return;
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++)
          binary += String.fromCharCode(bytes[i]!);
        const b64 = btoa(binary);
        ws.send(
          JSON.stringify({
            type: "audio",
            data: b64,
            mimeType: "audio/pcm;rate=16000",
          })
        );
      };
    } catch (err) {
      setErreur(err instanceof Error ? err.message : "Erreur démarrage voix");
      setEtat("erreur");
      arreter();
    }
  }, [arreter, jouerPcm, onNavigation]);

  // Nettoyage au démontage
  useEffect(() => () => arreter(), [arreter]);

  const basculer = () => {
    if (etat === "inactif" || etat === "erreur") void demarrer();
    else if (etat === "actif") arreter();
  };

  return (
    <div className="relative">
      <button
        onClick={basculer}
        disabled={etat === "connexion"}
        title={
          etat === "actif"
            ? "Couper la voix Eva"
            : "Activer la voix Eva (Vertex-UE)"
        }
        className={[
          "flex h-9 w-9 items-center justify-center rounded-full transition",
          etat === "actif"
            ? "animate-pulse bg-emerald-400 text-white shadow-lg shadow-emerald-400/50"
            : etat === "connexion"
              ? "cursor-wait bg-white/30 text-white"
              : etat === "erreur"
                ? "bg-red-400 text-white"
                : "bg-white/20 text-white hover:bg-white/30",
        ].join(" ")}
      >
        {etat === "erreur" ? (
          <AlertCircle className="h-4 w-4" />
        ) : etat === "actif" ? (
          <Phone className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>
      {erreur && (
        <div className="absolute right-0 top-11 z-50 w-60 rounded-xl bg-red-600 px-3 py-2 text-xs leading-relaxed text-white shadow-lg">
          {erreur}
        </div>
      )}
    </div>
  );
}
