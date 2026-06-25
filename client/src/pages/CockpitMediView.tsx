// client/src/pages/CockpitMediView.tsx
//
// COCKPIT écran scindé MediView : navigation + chat Eva (gauche) + Selenium live (droite).
// PHI-safe : aucune donnée patient ne transite par Eva ou le chat.
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Home,
  BookOpen,
  Search,
  Loader2,
  RotateCcw,
  Maximize2,
  MonitorPlay,
  ChevronRight,
  Send,
  MessageCircle,
} from "lucide-react";
import EvaVoiceMV from "@/components/EvaVoiceMV";

const VIEWER_URL = "/api/cockpit/viewer";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const RACCOURCIS = [
  { icon: Home, label: "Worklist", route: "/" },
  { icon: BookOpen, label: "Base de connaissances", route: "/admin/knowledge" },
  { icon: Search, label: "Recherche", route: "/knowledge" },
];

async function naviguerSelenium(page: string): Promise<void> {
  await fetch("/api/cockpit/naviguer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page }),
  });
}

async function streamChat(
  messages: ChatMsg[],
  onToken: (t: string) => void,
  onDone: (nav: string | null) => void
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
          nav?: string | null;
          error?: string;
        };
        if (d.t) onToken(d.t);
        if (d.done) onDone(d.nav ?? null);
      } catch {
        /* ignore */
      }
    }
  }
}

export default function CockpitMediView() {
  const [routeAffichee, setRouteAffichee] = useState("/");
  const [navEnCours, setNavEnCours] = useState(false);
  const [saisieRoute, setSaisieRoute] = useState("");

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatEnCours, setChatEnCours] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const naviguer = useCallback((route: string) => {
    setRouteAffichee(route);
    setNavEnCours(true);
    void naviguerSelenium(route).finally(() => setNavEnCours(false));
  }, []);

  const recharger = () => {
    if (iframeRef.current) {
      iframeRef.current.src = VIEWER_URL + "?t=" + Date.now();
    }
  };

  const soumettre = (e?: React.FormEvent) => {
    e?.preventDefault();
    const route = saisieRoute.trim();
    if (!route || navEnCours) return;
    naviguer(route.startsWith("/") ? route : "/" + route);
    setSaisieRoute("");
  };

  const envoyerChat = async (texte: string) => {
    if (!texte.trim() || chatEnCours) return;
    const userMsg: ChatMsg = { role: "user", content: texte.trim() };
    const historique = [...chatMessages, userMsg];
    setChatMessages([...historique, { role: "assistant", content: "" }]);
    setChatInput("");
    setChatEnCours(true);
    try {
      await streamChat(
        historique,
        delta => {
          setChatMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                role: "assistant",
                content: last.content + delta,
              };
            }
            return updated;
          });
        },
        nav => {
          // Strip NAV: directive from displayed text
          setChatMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                role: "assistant",
                content: last.content.replace(/\s*NAV:\/[^\s]*/g, "").trim(),
              };
            }
            return updated;
          });
          if (nav) naviguer(nav);
        }
      );
    } catch {
      setChatMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Erreur de connexion.",
          };
        }
        return updated;
      });
    } finally {
      setChatEnCours(false);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 dark:bg-slate-950">
      {/* ── GAUCHE : panneau Eva ─────────────────────────────────────────── */}
      <aside className="flex w-[320px] min-w-[260px] max-w-[28vw] flex-col bg-white shadow-xl dark:bg-slate-900">
        {/* En-tête */}
        <header className="flex items-center gap-3 bg-gradient-to-br from-violet-700 to-violet-900 px-4 py-3.5 text-white">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 ring-2 ring-white/40">
            <MonitorPlay className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 leading-tight">
            <p className="text-[15px] font-semibold tracking-tight">
              MediView Cockpit
            </p>
            <p className="text-xs text-violet-200/80">
              Navigation Selenium en direct
            </p>
          </div>
          {/* Bouton voix Eva */}
          <EvaVoiceMV onNavigation={naviguer} />
        </header>

        {/* Corps : navigation + route libre + chat IA */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Navigation rapide + route libre */}
          <div className="shrink-0 px-4 pt-5">
            <p className="mb-3 px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Navigation rapide
            </p>
            <div className="space-y-2">
              {RACCOURCIS.map(({ icon: Icon, label, route }) => (
                <button
                  key={route}
                  onClick={() => naviguer(route)}
                  disabled={navEnCours}
                  className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-left text-sm text-slate-700 transition hover:border-violet-300 hover:bg-violet-50/60 hover:shadow-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700/60"
                >
                  <Icon className="h-4 w-4 shrink-0 text-violet-500" />
                  <span className="flex-1">{label}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                </button>
              ))}
            </div>

            <p className="mb-3 mt-6 px-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Route libre
            </p>
            <form onSubmit={soumettre} className="flex gap-2">
              <input
                value={saisieRoute}
                onChange={e => setSaisieRoute(e.target.value)}
                placeholder="/viewer/42"
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={!saisieRoute.trim() || navEnCours}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-700 text-white hover:bg-violet-800 disabled:opacity-40"
              >
                {navEnCours ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
            </form>
          </div>

          {/* Séparateur */}
          <div className="mx-4 my-4 border-t border-slate-100 dark:border-slate-800" />

          {/* Chat Eva (IA navigation) */}
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <MessageCircle className="h-3.5 w-3.5 text-violet-500" />
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Chat Eva
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
              {chatMessages.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">
                  Posez une question à Eva ou demandez-lui de naviguer.
                </p>
              ) : (
                <div className="space-y-2">
                  {chatMessages.map((m, i) => (
                    <div
                      key={i}
                      className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={[
                          "max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed",
                          m.role === "user"
                            ? "bg-violet-600 text-white"
                            : "bg-white text-slate-700 shadow-sm dark:bg-slate-700 dark:text-slate-200",
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

            {/* Saisie chat */}
            <form
              onSubmit={e => {
                e.preventDefault();
                void envoyerChat(chatInput);
              }}
              className="mt-2 flex gap-2"
            >
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Demandez à Eva…"
                disabled={chatEnCours}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatEnCours}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-700 text-white hover:bg-violet-800 disabled:opacity-40"
              >
                {chatEnCours ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* ── DROITE : navigateur Selenium live (noVNC) ───────────────────── */}
      <main className="relative flex flex-1 flex-col">
        {/* Barre navigateur */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <button
            onClick={() => naviguer("/")}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Worklist"
          >
            <Home className="h-4 w-4" />
          </button>
          <button
            onClick={recharger}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Recharger"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <div className="flex flex-1 items-center gap-2 rounded-lg bg-slate-100 px-3 py-1 text-xs text-slate-500 dark:bg-slate-800">
            {navEnCours ? (
              <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
            ) : (
              <MonitorPlay className="h-3 w-3 text-emerald-500" />
            )}
            <span className="font-medium text-slate-600 dark:text-slate-300">
              horos.mbbssarl.ch
            </span>
            <span className="text-slate-400">{routeAffichee}</span>
          </div>
          <a
            href={`https://horos.mbbssarl.ch${routeAffichee}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Ouvrir dans MediView"
          >
            <Maximize2 className="h-4 w-4" />
          </a>
        </div>

        {/* Viewer noVNC */}
        <div className="relative flex-1 bg-[#0b1220]">
          <iframe
            ref={iframeRef}
            src={VIEWER_URL}
            title="MediView (Selenium live)"
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        </div>
      </main>
    </div>
  );
}
