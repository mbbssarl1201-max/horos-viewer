// client/src/components/EvaViewerPanel.tsx
// Panneau Eva gauche dans le viewer DICOM — écran scindé premium.
// Chat streamé + voix Vertex-UE. PHI-safe : aucune donnée patient transmise.
import { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Send,
  GripVertical,
  Loader2,
  MessageCircle,
  Sparkles,
  Brain,
  Zap,
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

const MIN_W = 260;
const MAX_W = 520;

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
      {/* ─── HEADER avatar ─────────────────────────────────────── */}
      <div className="relative flex flex-col items-center gap-2 px-4 pb-4 pt-6">
        {/* Bouton voix + fermer */}
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

        {/* Avatar */}
        <div className="relative">
          {/* Glow ring animé */}
          <div className="absolute -inset-1 rounded-full bg-gradient-to-br from-violet-500/40 to-purple-800/20 blur-md" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-900 shadow-xl ring-2 ring-violet-400/30">
            <span className="text-3xl font-bold text-white">E</span>
          </div>
          <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-[#0d1520]" />
        </div>

        {/* Nom */}
        <div className="text-center">
          <p className="text-base font-semibold text-white">Eva</p>
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-violet-400">
            Assistante Radiologique IA · cerveau 72B
          </span>
        </div>
      </div>

      {/* ─── Carte étude courante ───────────────────────────────── */}
      {(studyDescription || modality) && (
        <div className="mx-3 mb-3 rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5">
            <Brain className="h-3 w-3 text-violet-300" />
            <span className="text-[10px] font-semibold text-violet-300">
              Examen en cours
            </span>
          </div>
          {modality && (
            <span className="mr-1.5 inline-flex items-center rounded border border-violet-500/30 bg-violet-500/20 px-1.5 py-0 text-[9px] font-bold text-violet-300">
              {modality}
            </span>
          )}
          {studyDescription && (
            <span className="text-[11px] text-slate-300">
              {studyDescription}
            </span>
          )}
        </div>
      )}

      {/* ─── Zone scrollable ────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 pb-3">
        {/* Chat */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center gap-1.5">
            <MessageCircle className="h-3 w-3 text-violet-500" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Conversation
            </p>
          </div>

          <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-800/40 p-2 min-h-[160px]">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 py-4">
                <div className="flex flex-col items-center gap-1 text-center">
                  <Sparkles className="h-6 w-6 text-violet-400/60" />
                  <p className="text-[11px] text-slate-500">
                    Bonjour 👋 Je suis Eva.
                    <br />
                    Posez-moi une question sur cet examen.
                  </p>
                </div>
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

          {/* Suggestions rapides post-chat */}
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

          {/* Input */}
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

        {/* Raccourcis radiologiques */}
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
        title="Redimensionner"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 flex items-center justify-center">
          <GripVertical className="h-4 w-4 text-slate-600 opacity-0 transition group-hover:opacity-100" />
        </div>
      </div>
    </div>
  );
}
