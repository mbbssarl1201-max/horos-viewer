// client/src/components/EvaViewerPanel.tsx
// Panneau Eva gauche — visage animé + chat + actions Selenium.
// Quand il s'ouvre, Selenium navigue automatiquement vers l'étude courante.
// Les actions rapides pilotent le navigateur Selenium via POST /api/cockpit/action.
// PHI-safe : aucune donnée patient transmise.
import { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Send,
  Loader2,
  Sparkles,
  Zap,
  MousePointerClick,
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
  studyId?: number | null;
  /** Vue « navigateur piloté » (noVNC) affichée à la place de l'étude. */
  live?: boolean;
  onLiveChange?: (live: boolean) => void;
}

const SUGGESTIONS_BY_MODALITY: Record<string, string[]> = {
  CT: [
    "Quels fenêtrages appliquer pour cette région ?",
    "Présente les diagnostics différentiels probables",
    "Décris la sémiologie des lésions visibles",
  ],
  MR: [
    "Analyse les séquences disponibles (T1/T2/DWI/Gado)",
    "Y a-t-il une restriction de diffusion suspecte ?",
    "Quel score ou classification s'applique ?",
  ],
  US: [
    "Caractérise les lésions (écho, vascularisation, shadowing)",
    "Les mesures sont-elles dans la norme ?",
    "Quel diagnostic différentiel pour cette image ?",
  ],
  MG: [
    "Évalue la densité ACR et classe en BI-RADS",
    "Y a-t-il des microcalcifications suspectes ?",
    "Décris les marges et la densité de la masse",
  ],
  PT: [
    "Quel est le SUVmax de la lésion hyperactive ?",
    "Y a-t-il des foyers de fixation pathologique ?",
    "Corrèle les zones de captation avec le CT de fusion",
  ],
  NM: [
    "Interprète la scintigraphie et les zones d'hypofixation",
    "Y a-t-il une asymétrie de captation significative ?",
    "Quel protocole d'acquisition a été utilisé ?",
  ],
  XA: [
    "Décris la morphologie vasculaire et les sténoses",
    "Quel grade de sténose selon NASCET ou TIMI ?",
    "Y a-t-il des anomalies de perfusion ?",
  ],
  DEFAULT: [
    "Présente les principales anomalies de cet examen",
    "Propose un diagnostic principal et des diagnostics différentiels",
    "Aide-moi à structurer le compte rendu",
  ],
};

// Actions Selenium prédéfinies pour le viewer DICOM
const SELENIUM_ACTIONS = [
  { label: "Poumon", selector: 'button[title^="Lung"]', icon: "🫁" },
  { label: "Os", selector: 'button[title^="Bone"]', icon: "🦴" },
  { label: "Cerveau", selector: 'button[title^="Brain"]', icon: "🧠" },
  { label: "Abdomen", selector: 'button[title^="Abdomen"]', icon: "🫀" },
  { label: "Défaut", selector: 'button[title^="Default"]', icon: "⚙️" },
  { label: "CR IA", selector: "button.toolbar-btn-cr", icon: "📋" },
];

async function triggerSeleniumAction(
  type: "cliquer" | "taper" | "defiler",
  payload: Record<string, unknown>
): Promise<void> {
  await fetch("/api/cockpit/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...payload }),
  });
}

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

function EvaFace({ speaking }: { speaking: boolean }) {
  return (
    <div className="relative flex items-center justify-center">
      <div
        className={`absolute inset-[-6px] rounded-full transition-all duration-700 ${
          speaking
            ? "shadow-[0_0_40px_12px_rgba(20,184,166,0.5)]"
            : "shadow-[0_0_20px_6px_rgba(20,184,166,0.25)]"
        }`}
      />
      <div
        className={`absolute inset-[-3px] rounded-full border-2 transition-all duration-500 ${
          speaking ? "border-teal-400/80" : "border-teal-500/50"
        }`}
      />
      <div className="relative h-14 w-14 lg:h-20 lg:w-20 overflow-hidden rounded-full shadow-2xl">
        <img
          src="/eva.png"
          alt="Eva"
          className="h-full w-full object-cover object-top"
        />
      </div>
      <span className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-[#0d1520]" />
    </div>
  );
}

export default function EvaViewerPanel({
  onClose,
  studyDescription,
  modality,
  studyId,
  live,
  onLiveChange,
}: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Navigue automatiquement Selenium vers l'étude courante à l'ouverture
  useEffect(() => {
    if (!studyId) return;
    void fetch("/api/cockpit/naviguer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: `/viewer/${studyId}` }),
    });
  }, [studyId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const handleAction = async (action: (typeof SELENIUM_ACTIONS)[0]) => {
    // Une action Selenium ne se voit que sur l'écran piloté : on y bascule.
    onLiveChange?.(true);
    setActionStatus(`→ ${action.label}…`);
    try {
      await triggerSeleniumAction("cliquer", { selector: action.selector });
      setActionStatus(`✓ ${action.label}`);
    } catch {
      setActionStatus(`✗ ${action.label}`);
    }
    setTimeout(() => setActionStatus(null), 2000);
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void envoyer(input);
  };

  const suggestions =
    SUGGESTIONS_BY_MODALITY[modality ?? ""] ?? SUGGESTIONS_BY_MODALITY.DEFAULT;

  return (
    <div className="flex h-full w-[260px] lg:w-[300px] xl:w-[340px] 2xl:w-[380px] shrink-0 flex-col bg-[#0d1520]">
      {/* ─── HEADER ─────────────────────────────────────────────────────── */}
      <div className="relative flex flex-col items-center gap-1 border-b border-slate-800 px-3 pb-3 pt-4 lg:px-4 lg:pb-4 lg:pt-6">
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

        <EvaFace speaking={loading} />

        <div className="mt-2 lg:mt-5 text-center">
          <p className="text-sm lg:text-base font-semibold text-white">Eva</p>
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-violet-400">
            Assistante Radiologique · Gemini EU
          </span>
        </div>

        {(studyDescription || modality) && (
          <div className="mt-2 w-full rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              {modality && (
                <span className="inline-flex items-center rounded border border-violet-500/30 bg-violet-500/20 px-1.5 py-0 text-[9px] font-bold text-violet-300">
                  {modality}
                </span>
              )}
              {studyDescription && (
                <span className="truncate text-[11px] text-slate-300">
                  {studyDescription}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── ACTIONS SELENIUM ──────────────────────────────────────────── */}
      <div className="border-b border-slate-800 px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          <MousePointerClick className="h-3 w-3 text-emerald-400" />
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            Actions Selenium
          </p>
          {actionStatus && (
            <span className="ml-auto text-[10px] text-emerald-400">
              {actionStatus}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {SELENIUM_ACTIONS.map(a => (
            <button
              key={a.label}
              onClick={() => void handleAction(a)}
              className="flex flex-col items-center gap-0.5 rounded-lg border border-slate-700/60 bg-slate-800/60 px-1 py-2 text-center transition hover:border-emerald-500/40 hover:bg-slate-700/80 active:scale-95"
            >
              <span className="text-base leading-none">{a.icon}</span>
              <span className="text-[9px] text-slate-400 leading-tight">
                {a.label}
              </span>
            </button>
          ))}
        </div>
        {onLiveChange && (
          <button
            onClick={() => onLiveChange(!live)}
            className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition ${
              live
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                : "border-slate-700/60 bg-slate-800/60 text-slate-400 hover:border-emerald-500/40 hover:text-slate-200"
            }`}
            title={
              live
                ? "Réafficher l'étude DICOM locale"
                : "Afficher le navigateur que pilote Eva (l'étude reste ouverte)"
            }
          >
            <MousePointerClick className="h-3 w-3" />
            {live ? "Revenir à l'étude" : "Voir l'écran piloté"}
          </button>
        )}
      </div>

      {/* ─── CHAT ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-2 overflow-hidden px-3 py-3">
        <div className="mb-1 flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-violet-500" />
          <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            Conversation
          </p>
        </div>

        <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-800/40 p-2">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-3">
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
          <div className="flex gap-1 overflow-x-auto pb-0.5">
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

        <form onSubmit={submit} className="flex gap-1.5">
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

        {/* Actions rapides chat */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-amber-500" />
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Actions rapides
            </p>
          </div>
          <div className="space-y-1">
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
                className="flex w-full items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-1.5 text-left text-xs text-slate-300 transition hover:bg-slate-700/80 hover:text-white disabled:opacity-40"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
