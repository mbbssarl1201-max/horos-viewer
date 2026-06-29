// client/src/components/EvaViewerPanel.tsx
// Panneau Eva gauche dans le viewer DICOM — visage animé + Selenium noVNC + chat.
// PHI-safe : aucune donnée patient transmise via Eva ou noVNC.
import { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Send,
  GripVertical,
  Loader2,
  MessageCircle,
  Sparkles,
  Zap,
  MonitorPlay,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import EvaVoiceMV from "./EvaVoiceMV";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  onClose: () => void;
  studyDescription?: string | null;
  modality?: string | null;
  width: number;
  onWidthChange: (w: number) => void;
}

const MIN_W = 280;
const MAX_W = 560;

const SUGGESTIONS_BY_MODALITY: Record<string, string[]> = {
  CT: [
    "Analysez cette série",
    "Y a-t-il une anomalie ?",
    "Comparaison antérieure",
  ],
  MR: ["Interprétez l'IRM", "Zones suspectes ?", "Technique utilisée ?"],
  US: ["Décrivez l'écho", "Mesures normales ?", "Vascularisation ?"],
  MG: ["Densité ACR ?", "BI-RADS ?", "Microcalcifications ?"],
  DEFAULT: ["Analysez cet examen", "Anomalie détectée ?", "Compte rendu IA"],
};

async function streamChat(
  messages: ChatMsg[],
  onToken: (t: string) => void,
  onDone: () => void
): Promise<void> {
  const resp = await fetch("/api/cockpit/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!resp.ok || !resp.body) throw new Error("Erreur chat");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const d = JSON.parse(line.slice(5).trim()) as {
          t?: string;
          done?: boolean;
        };
        if (d.t) onToken(d.t);
        if (d.done) onDone();
      } catch {
        /* ignore */
      }
    }
  }
}

// Visage animé Eva
function EvaFace({ speaking }: { speaking: boolean }) {
  return (
    <div className="relative flex items-center justify-center">
      {/* Anneaux de glow */}
      <div
        className={`absolute inset-0 rounded-full transition-all duration-700 ${
          speaking
            ? "scale-110 bg-violet-500/20 shadow-[0_0_30px_10px_rgba(139,92,246,0.35)]"
            : "scale-100 bg-violet-500/10 shadow-[0_0_15px_4px_rgba(139,92,246,0.15)]"
        }`}
      />
      <div
        className={`absolute inset-[-4px] rounded-full border transition-all duration-500 ${
          speaking
            ? "border-violet-400/50 shadow-[0_0_20px_rgba(139,92,246,0.5)]"
            : "border-violet-600/20"
        }`}
      />
      {/* Cercle principal */}
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 via-violet-700 to-purple-900 shadow-xl">
        {/* Visage SVG */}
        <svg viewBox="0 0 80 80" className="h-16 w-16" fill="none">
          {/* Reflet haut */}
          <ellipse
            cx="30"
            cy="22"
            rx="14"
            ry="7"
            fill="white"
            fillOpacity="0.08"
            transform="rotate(-20 30 22)"
          />
          {/* Yeux */}
          <ellipse
            cx="28"
            cy="33"
            rx="4"
            ry={speaking ? "3.5" : "4"}
            fill="white"
            fillOpacity="0.9"
            className="transition-all duration-200"
          />
          <ellipse
            cx="52"
            cy="33"
            rx="4"
            ry={speaking ? "3.5" : "4"}
            fill="white"
            fillOpacity="0.9"
            className="transition-all duration-200"
          />
          {/* Pupilles */}
          <circle cx="29" cy="34" r="2" fill="#1e1b4b" />
          <circle cx="53" cy="34" r="2" fill="#1e1b4b" />
          {/* Reflets pupilles */}
          <circle cx="30" cy="33" r="0.8" fill="white" fillOpacity="0.8" />
          <circle cx="54" cy="33" r="0.8" fill="white" fillOpacity="0.8" />
          {/* Bouche */}
          {speaking ? (
            // Bouche ouverte animation parole
            <ellipse
              cx="40"
              cy="52"
              rx="8"
              ry={4}
              fill="white"
              fillOpacity="0.85"
            />
          ) : (
            // Sourire
            <path
              d="M31 50 Q40 58 49 50"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeOpacity="0.85"
            />
          )}
          {/* Dents si parle */}
          {speaking && (
            <ellipse
              cx="40"
              cy="51"
              rx="5"
              ry="2.5"
              fill="white"
              fillOpacity="0.95"
            />
          )}
        </svg>
        {/* Point vert statut */}
        <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-[#0d1520]" />
      </div>
      {/* Barres audio si parle */}
      {speaking && (
        <div className="absolute -bottom-5 flex items-end gap-0.5 h-4">
          {[3, 5, 7, 4, 6, 8, 5, 3].map((h, i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-violet-400"
              style={{
                height: `${h * 2}px`,
                animation: `pulse ${0.4 + i * 0.07}s ease-in-out infinite alternate`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function EvaViewerPanel({
  onClose,
  studyDescription,
  modality,
  width,
  onWidthChange,
}: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [vncOpen, setVncOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef(0);
  const widthStart = useRef(0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      onWidthChange(
        Math.min(
          MAX_W,
          Math.max(MIN_W, widthStart.current + (e.clientX - dragStart.current))
        )
      );
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onWidthChange]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = e.clientX;
    widthStart.current = width;
  };

  const envoyer = useCallback(
    async (texte: string) => {
      if (!texte.trim() || loading) return;
      const userMsg: ChatMsg = { role: "user", content: texte.trim() };
      const historique = [...messages, userMsg];
      setMessages([...historique, { role: "assistant", content: "" }]);
      setInput("");
      setLoading(true);
      try {
        await streamChat(
          historique,
          delta => {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant")
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: last.content + delta,
                };
              return updated;
            });
          },
          () => setLoading(false)
        );
      } catch {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant")
            updated[updated.length - 1] = {
              role: "assistant",
              content: "Erreur de connexion à Eva.",
            };
          return updated;
        });
        setLoading(false);
      }
    },
    [messages, loading]
  );

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void envoyer(input);
  };

  const suggestions =
    SUGGESTIONS_BY_MODALITY[modality ?? ""] ?? SUGGESTIONS_BY_MODALITY.DEFAULT;

  return (
    <div
      className="relative flex flex-col bg-[#0d1520] shadow-2xl shrink-0"
      style={{ width }}
    >
      {/* ─── HEADER ──────────────────────────────────────────────── */}
      <div className="relative flex flex-col items-center gap-1 px-4 pb-3 pt-6">
        {/* Voix + fermer */}
        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          <EvaVoiceMV />
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-white/10 hover:text-white"
            title="Fermer Eva"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Visage animé */}
        <EvaFace speaking={loading} />

        {/* Nom */}
        <div className="mt-5 text-center">
          <p className="text-base font-semibold text-white">Eva</p>
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-violet-400">
            Assistante Radiologique IA · cerveau 72B
          </span>
        </div>
      </div>

      {/* ─── Carte étude ─────────────────────────────────────────── */}
      {(studyDescription || modality) && (
        <div className="mx-3 mb-2 rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2">
          <div className="flex items-center gap-1.5">
            {modality && (
              <span className="inline-flex items-center rounded border border-violet-500/30 bg-violet-500/20 px-1.5 py-0 text-[9px] font-bold text-violet-300">
                {modality}
              </span>
            )}
            {studyDescription && (
              <span className="text-[11px] text-slate-300 truncate">
                {studyDescription}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ─── Selenium noVNC (collapsible) ────────────────────────── */}
      <div className="mx-3 mb-2 overflow-hidden rounded-xl border border-slate-700/60">
        <button
          onClick={() => setVncOpen(o => !o)}
          className="flex w-full items-center gap-2 bg-slate-800/60 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-400 transition hover:bg-slate-700/60 hover:text-slate-200"
        >
          <MonitorPlay className="h-3 w-3 text-emerald-400" />
          <span className="flex-1">Vue Selenium live</span>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {vncOpen ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
        {vncOpen && (
          <div className="relative bg-black" style={{ height: 220 }}>
            <iframe
              src="/api/cockpit/viewer"
              className="absolute inset-0 h-full w-full border-0"
              title="Eva Selenium live"
              sandbox="allow-same-origin allow-scripts allow-forms"
            />
          </div>
        )}
      </div>

      {/* ─── Zone scrollable ──────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 pb-3">
        {/* Chat */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-violet-500" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Conversation
            </p>
          </div>

          <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-800/40 p-2 min-h-[140px]">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-3">
                <p className="text-center text-[11px] text-slate-500 leading-relaxed">
                  Posez-moi une question
                  <br />
                  sur cet examen.
                </p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => void envoyer(s)}
                      disabled={loading}
                      className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] text-slate-400 transition hover:border-violet-500/60 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-40"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={[
                        "max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap",
                        m.role === "user"
                          ? "bg-violet-600 text-white"
                          : "bg-slate-700 text-slate-200",
                      ].join(" ")}
                    >
                      {m.content || (
                        <span className="flex items-center gap-1 opacity-60">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Eva réfléchit…
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          {messages.length > 0 && !loading && (
            <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => void envoyer(s)}
                  className="shrink-0 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500 transition hover:border-violet-500/50 hover:text-slate-300"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="mt-1.5 flex gap-1.5">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Demandez à Eva…"
              disabled={loading}
              className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-700 text-white transition hover:bg-violet-600 disabled:opacity-40"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </form>
        </div>

        {/* Actions rapides */}
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-amber-500" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Actions rapides
            </p>
          </div>
          <div className="space-y-1.5">
            {[
              {
                label: "Pré-analyse IA complète",
                prompt:
                  "Fais une pré-analyse radiologique complète de cet examen",
              },
              {
                label: "Points d'attention",
                prompt: "Quels sont les points d'attention sur cet examen ?",
              },
              {
                label: "Préparer le compte rendu",
                prompt: "Aide-moi à préparer le compte rendu de cet examen",
              },
            ].map(({ label, prompt }) => (
              <button
                key={label}
                onClick={() => void envoyer(prompt)}
                disabled={loading}
                className="flex w-full items-center gap-2.5 rounded-xl bg-slate-800/60 px-3 py-2 text-left text-xs text-slate-300 transition hover:bg-slate-700/80 hover:text-white disabled:opacity-40"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        className="group absolute right-0 top-0 bottom-0 z-10 w-1 cursor-col-resize bg-slate-800 hover:bg-violet-600/60 active:bg-violet-600"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 flex items-center justify-center">
          <GripVertical className="h-4 w-4 text-slate-600 opacity-0 transition group-hover:opacity-100" />
        </div>
      </div>
    </div>
  );
}
