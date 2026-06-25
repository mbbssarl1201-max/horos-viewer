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
  Activity,
  Calendar,
  ExternalLink,
  GripVertical,
} from "lucide-react";
import EvaVoiceMV from "@/components/EvaVoiceMV";

const VIEWER_URL = "/api/cockpit/viewer";
const MIN_PANEL = 240;
const MAX_PANEL = 480;

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

interface Etude {
  id: number;
  studyDate?: string | null;
  studyDescription?: string | null;
  modality?: string | null;
  numberOfSeries?: number | null;
  numberOfInstances?: number | null;
  status?: string | null;
}

const RACCOURCIS = [
  { icon: Home, label: "Worklist", route: "/" },
  { icon: BookOpen, label: "Connaissances", route: "/admin/knowledge" },
  { icon: Search, label: "Recherche", route: "/knowledge" },
];

const SUGGESTIONS = [
  "Liste les examens d'aujourd'hui",
  "Ouvre la worklist",
  "Quels examens sont en attente ?",
];

const MODALITY_COLOR: Record<string, string> = {
  CT: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  MR: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  US: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  XA: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  CR: "bg-slate-400/20 text-slate-300 border-slate-400/30",
  DX: "bg-slate-400/20 text-slate-300 border-slate-400/30",
  PT: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
};

function modalityClass(mod?: string | null) {
  return (
    MODALITY_COLOR[mod ?? ""] ??
    "bg-slate-500/20 text-slate-300 border-slate-500/30"
  );
}

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
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatEnCours, setChatEnCours] = useState(false);

  const [etudes, setEtudes] = useState<Etude[]>([]);
  const [etudesChargement, setEtudesChargement] = useState(false);

  const [panelWidth, setPanelWidth] = useState(320);
  const dragging = useRef(false);
  const dragStart = useRef(0);
  const widthStart = useRef(0);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Fetch recent studies on mount
  useEffect(() => {
    setEtudesChargement(true);
    fetch("/api/cockpit/studies/recent")
      .then(r => r.json())
      .then((data: Etude[]) => setEtudes(data))
      .catch(() => {})
      .finally(() => setEtudesChargement(false));
  }, []);

  // Drag-resize panel
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - dragStart.current;
      setPanelWidth(
        Math.min(MAX_PANEL, Math.max(MIN_PANEL, widthStart.current + delta))
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
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = e.clientX;
    widthStart.current = panelWidth;
  };

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

  const commitUrl = () => {
    setUrlEditing(false);
    const route = urlDraft.trim();
    if (route) naviguer(route.startsWith("/") ? route : "/" + route);
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
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950">
      {/* ── GAUCHE : panneau Eva ─────────────────────────────────────────── */}
      <aside
        style={{ width: panelWidth }}
        className="flex min-w-0 flex-col bg-slate-900 shadow-2xl"
      >
        {/* En-tête */}
        <header className="flex items-center gap-3 bg-gradient-to-br from-violet-700 to-violet-900 px-4 py-3.5 text-white">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 ring-2 ring-white/30">
            <MonitorPlay className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[14px] font-semibold tracking-tight">
              MediView Cockpit
            </p>
            <p className="truncate text-[11px] text-violet-200/70">
              Navigation Selenium en direct
            </p>
          </div>
          <EvaVoiceMV onNavigation={naviguer} />
        </header>

        {/* Corps scrollable */}
        <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden">
          {/* Navigation rapide */}
          <div className="shrink-0 px-3 pt-4">
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Navigation rapide
            </p>
            <div className="space-y-1">
              {RACCOURCIS.map(({ icon: Icon, label, route }) => {
                const actif = routeAffichee === route;
                return (
                  <button
                    key={route}
                    onClick={() => naviguer(route)}
                    disabled={navEnCours}
                    className={[
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition",
                      actif
                        ? "bg-violet-600/25 text-violet-300 ring-1 ring-violet-500/40"
                        : "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
                      "disabled:opacity-40",
                    ].join(" ")}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${actif ? "text-violet-400" : "text-slate-500"}`}
                    />
                    <span className="flex-1 truncate">{label}</span>
                    {actif && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Route libre */}
          <div className="shrink-0 px-3 pt-4">
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Route libre
            </p>
            <form onSubmit={soumettre} className="flex gap-1.5">
              <input
                value={saisieRoute}
                onChange={e => setSaisieRoute(e.target.value)}
                placeholder="/viewer/42"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50"
              />
              <button
                type="submit"
                disabled={!saisieRoute.trim() || navEnCours}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-700 text-white transition hover:bg-violet-600 disabled:opacity-40"
              >
                {navEnCours ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            </form>
          </div>

          {/* Études récentes */}
          <div className="shrink-0 px-3 pt-5">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <Activity className="h-3 w-3 text-slate-500" />
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Études récentes
              </p>
              {etudesChargement && (
                <Loader2 className="h-3 w-3 animate-spin text-slate-600" />
              )}
            </div>
            {etudes.length === 0 && !etudesChargement ? (
              <p className="px-1 text-xs text-slate-600">
                Aucune étude cette semaine.
              </p>
            ) : (
              <div className="space-y-1">
                {etudes.slice(0, 8).map(e => {
                  const actif = routeAffichee === `/viewer/${e.id}`;
                  return (
                    <button
                      key={e.id}
                      onClick={() => naviguer(`/viewer/${e.id}`)}
                      disabled={navEnCours}
                      className={[
                        "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition",
                        actif
                          ? "bg-violet-600/20 ring-1 ring-violet-500/40"
                          : "hover:bg-slate-800",
                        "disabled:opacity-40",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center rounded border px-1 py-0 text-[9px] font-bold leading-4 ${modalityClass(e.modality)}`}
                        >
                          {e.modality ?? "?"}
                        </span>
                        <span className="truncate text-xs font-medium text-slate-200">
                          {e.studyDescription ?? "Sans titre"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-slate-500">
                        <Calendar className="h-2.5 w-2.5 shrink-0" />
                        <span>{e.studyDate ?? "—"}</span>
                        {e.numberOfSeries != null && (
                          <span className="ml-auto text-slate-600">
                            {e.numberOfSeries} série
                            {e.numberOfSeries !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mx-3 my-4 border-t border-slate-800" />

          {/* Chat Eva */}
          <div className="flex min-h-[200px] flex-1 flex-col px-3 pb-3">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <MessageCircle className="h-3 w-3 text-violet-500" />
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Chat Eva
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-800/40 p-2">
              {chatMessages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 py-4">
                  <p className="text-center text-[11px] text-slate-500">
                    Posez une question à Eva ou choisissez :
                  </p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        onClick={() => void envoyerChat(s)}
                        disabled={chatEnCours}
                        className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-[10px] text-slate-400 transition hover:border-violet-500/60 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-40"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {chatMessages.map((m, i) => (
                    <div
                      key={i}
                      className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={[
                          "max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed",
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

            {/* Suggestions rapides si chat non vide */}
            {chatMessages.length > 0 && !chatEnCours && (
              <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => void envoyerChat(s)}
                    className="shrink-0 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500 transition hover:border-violet-500/50 hover:text-slate-300"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Saisie */}
            <form
              onSubmit={e => {
                e.preventDefault();
                void envoyerChat(chatInput);
              }}
              className="mt-1.5 flex gap-1.5"
            >
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Demandez à Eva…"
                disabled={chatEnCours}
                className="flex-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatEnCours}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-700 text-white transition hover:bg-violet-600 disabled:opacity-40"
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

      {/* ── POIGNÉE DE REDIMENSIONNEMENT ───────────────────────────────── */}
      <div
        onMouseDown={startDrag}
        className="group relative z-10 w-1 cursor-col-resize bg-slate-800 hover:bg-violet-600/60 active:bg-violet-600"
        title="Redimensionner le panneau"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 flex items-center justify-center">
          <GripVertical className="h-4 w-4 text-slate-600 opacity-0 transition group-hover:opacity-100" />
        </div>
      </div>

      {/* ── DROITE : navigateur Selenium live (noVNC) ───────────────────── */}
      <main className="relative flex flex-1 flex-col bg-[#0b1220]">
        {/* Barre navigateur */}
        <div className="flex items-center gap-1.5 border-b border-slate-800 bg-slate-900 px-2 py-1.5">
          <button
            onClick={() => naviguer("/")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            title="Worklist"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={recharger}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            title="Recharger"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          {/* Barre URL cliquable */}
          {urlEditing ? (
            <form
              onSubmit={e => {
                e.preventDefault();
                commitUrl();
              }}
              className="flex flex-1 items-center"
            >
              <input
                ref={urlInputRef}
                autoFocus
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                onBlur={commitUrl}
                onKeyDown={e => e.key === "Escape" && setUrlEditing(false)}
                className="flex-1 rounded-md border border-violet-500 bg-slate-800 px-3 py-1 text-xs text-slate-100 outline-none"
              />
            </form>
          ) : (
            <button
              onClick={() => {
                setUrlDraft(routeAffichee);
                setUrlEditing(true);
              }}
              className="flex flex-1 items-center gap-2 rounded-md bg-slate-800 px-3 py-1 text-left text-xs text-slate-400 transition hover:bg-slate-700"
              title="Modifier la route"
            >
              {navEnCours ? (
                <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
              ) : (
                <MonitorPlay className="h-3 w-3 shrink-0 text-emerald-500" />
              )}
              <span className="font-medium text-slate-500">
                mediview.mbbssarl.ch
              </span>
              <span className="truncate text-slate-400">{routeAffichee}</span>
            </button>
          )}

          <a
            href={`https://mediview.mbbssarl.ch${routeAffichee}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            title="Ouvrir dans MediView"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a
            href={`https://mediview.mbbssarl.ch${routeAffichee}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-300 sm:flex"
            title="Plein écran"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </a>
        </div>

        {/* Viewer noVNC */}
        <div className="relative flex-1">
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
