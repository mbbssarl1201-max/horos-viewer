// client/src/pages/CockpitMediView.tsx
//
// COCKPIT écran scindé MediView : navigation + chat Eva (gauche) + Selenium live (droite).
// PHI-safe : aucune donnée patient ne transite par Eva ou le chat.
import { useRef, useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Home,
  BookOpen,
  Search,
  Loader2,
  RotateCcw,
  Maximize2,
  MonitorPlay,
  Send,
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
  "Ouvre les examens du jour",
  "Quelle est la valeur HU normale du parenchyme pulmonaire ?",
  "Explique les critères Fleischner pour les nodules",
  "Recherche les IRM cérébrales récentes",
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
  onDone: (
    nav: string | null,
    cmds: Array<{ type: string; payload: string }>
  ) => void
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
          cmds?: Array<{ type: string; payload: string }>;
          error?: string;
        };
        if (d.t) onToken(d.t);
        if (d.done) onDone(d.nav ?? null, d.cmds ?? []);
      } catch {
        /* ignore */
      }
    }
  }
}

export default function CockpitMediView({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const [, reactNavigate] = useLocation();
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

  // Navigate Selenium to worklist on mount
  useEffect(() => {
    void naviguerSelenium("/");
  }, []);

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

  const naviguer = useCallback(
    (route: string) => {
      setRouteAffichee(route);
      setNavEnCours(true);
      reactNavigate(route); // BUG-2/3 fix: React router EN PREMIER
      void naviguerSelenium(route).finally(() => setNavEnCours(false));
    },
    [reactNavigate]
  );

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
        (nav, cmds) => {
          // Nettoyer les commandes du texte affiché
          setChatMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = {
                role: "assistant",
                content: last.content
                  .replace(/\s*NAV:\/[^\s\n]*/g, "")
                  .replace(/\s*CMD:[^\n]*/g, "")
                  .trim(),
              };
            }
            return updated;
          });
          // Exécuter toutes les commandes Eva
          for (const cmd of cmds) {
            if (cmd.type === "nav") {
              reactNavigate(cmd.payload);
              void naviguerSelenium(cmd.payload);
            } else if (cmd.type === "album") {
              window.dispatchEvent(
                new CustomEvent("eva:selectAlbum", { detail: cmd.payload })
              );
            } else if (cmd.type === "search") {
              window.dispatchEvent(
                new CustomEvent("eva:search", { detail: cmd.payload })
              );
            } else if (cmd.type === "generer-cr") {
              const studyId = Number(cmd.payload);
              if (studyId) {
                setChatMessages(prev => [
                  ...prev,
                  {
                    role: "assistant",
                    content: "⏳ Génération du compte rendu IA…",
                  },
                ]);
                fetch("/api/cockpit/generer-cr", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ studyId }),
                })
                  .then(r => r.json())
                  .then((d: any) => {
                    setChatMessages(prev => [
                      ...prev.slice(0, -1),
                      {
                        role: "assistant",
                        content: d.ok
                          ? `**Compte rendu IA — étude ${studyId}**\n\n${d.text}`
                          : `Erreur génération CR : ${d.error}`,
                      },
                    ]);
                  })
                  .catch(() =>
                    setChatMessages(prev => [
                      ...prev.slice(0, -1),
                      {
                        role: "assistant",
                        content: "Erreur lors de la génération du CR.",
                      },
                    ])
                  );
              }
            } else if (cmd.type === "envoyer-rapport") {
              const [studyIdStr, email] = cmd.payload.split(":");
              const studyId = Number(studyIdStr);
              if (studyId && email?.includes("@")) {
                // Récupère le dernier CR affiché dans le chat pour l'envoyer
                const lastCr =
                  [...chatMessages]
                    .reverse()
                    .find(
                      m =>
                        m.role === "assistant" &&
                        m.content.includes("Compte rendu")
                    )?.content ?? "";
                fetch("/api/cockpit/envoyer-rapport", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ studyId, to: email, contenu: lastCr }),
                })
                  .then(r => r.json())
                  .then((d: any) => {
                    setChatMessages(prev => [
                      ...prev,
                      {
                        role: "assistant",
                        content: d.success
                          ? `✅ Rapport envoyé à ${email}.`
                          : `❌ Envoi échoué : ${d.error}`,
                      },
                    ]);
                  })
                  .catch(() =>
                    setChatMessages(prev => [
                      ...prev,
                      {
                        role: "assistant",
                        content: "Erreur lors de l'envoi du rapport.",
                      },
                    ])
                  );
              }
            }
          }
          // Fallback nav (compatibilité)
          if (nav && !cmds.some(c => c.type === "nav")) {
            reactNavigate(nav);
            void naviguerSelenium(nav);
          }
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
    <div
      className={
        embedded
          ? "flex h-full overflow-hidden bg-[#0d1520] shrink-0"
          : "flex h-screen w-screen overflow-hidden bg-slate-950"
      }
    >
      {/* ── GAUCHE : panneau Eva ─────────────────────────────────────────── */}
      <aside
        style={embedded ? undefined : { width: panelWidth }}
        className={`flex flex-col bg-[#0d1520] shadow-2xl ${embedded ? "w-full min-w-0" : "min-w-0"}`}
      >
        {/* Avatar + identité */}
        <div className="relative flex flex-col items-center gap-1 border-b border-slate-800/80 px-3 pb-3 pt-4">
          <div className="absolute right-2 top-2">
            <EvaVoiceMV onNavigation={naviguer} />
          </div>

          {/* Photo Eva */}
          <div className="relative flex items-center justify-center">
            <div
              className={`absolute inset-[-5px] rounded-full transition-all duration-700 ${chatEnCours ? "shadow-[0_0_32px_10px_rgba(20,184,166,0.5)]" : "shadow-[0_0_16px_5px_rgba(20,184,166,0.25)]"}`}
            />
            <div
              className={`absolute inset-[-3px] rounded-full border-2 transition-all duration-500 ${chatEnCours ? "border-teal-400/80" : "border-teal-500/50"}`}
            />
            <div
              className={`relative overflow-hidden rounded-full shadow-2xl ${embedded ? "h-16 w-16" : "h-20 w-20"}`}
            >
              <img
                src="/eva.png"
                alt="Eva"
                className="h-full w-full object-cover object-top"
              />
            </div>
            <span className="absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-[#0d1520]" />
          </div>

          <div className="mt-1.5 text-center">
            <p
              className={`font-semibold text-white tracking-wide ${embedded ? "text-base" : "text-lg"}`}
            >
              Eva
            </p>
            <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-teal-400">
              Assistante Radiologique · Gemini EU
            </span>
          </div>

          {/* Statut */}
          <div className="mt-1 flex items-center gap-1.5 rounded-full border border-teal-500/20 bg-teal-500/10 px-2.5 py-0.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${chatEnCours ? "bg-teal-300 animate-pulse" : "bg-emerald-400"}`}
            />
            <span className="text-[9px] text-teal-300 font-medium">
              {chatEnCours ? "Eva réfléchit…" : "En ligne · prête à piloter"}
            </span>
          </div>
        </div>

        {/* Raccourcis rapides */}
        <div className="flex gap-1.5 border-b border-slate-800/60 px-3 py-2">
          {RACCOURCIS.map(({ icon: Icon, label, route }) => (
            <button
              key={route}
              onClick={() => naviguer(route)}
              disabled={navEnCours}
              title={label}
              className="flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-teal-400 disabled:opacity-40"
            >
              <Icon className="h-4 w-4" />
              <span className="text-[9px]">{label}</span>
            </button>
          ))}
        </div>

        {/* Chat — zone principale */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {chatMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <p className="text-[11px] text-slate-600 text-center px-4">
                  Posez une question à Eva ou choisissez une suggestion
                </p>
                <div className="flex flex-col gap-2 w-full">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => void envoyerChat(s)}
                      disabled={chatEnCours}
                      className="rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2.5 text-left text-[11px] text-slate-400 transition hover:border-teal-500/40 hover:bg-slate-700/60 hover:text-slate-200 disabled:opacity-40"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {chatMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {m.role === "assistant" && (
                      <div className="mr-2 mt-1 h-6 w-6 shrink-0 overflow-hidden rounded-full">
                        <img
                          src="/eva.png"
                          alt="Eva"
                          className="h-full w-full object-cover object-top"
                        />
                      </div>
                    )}
                    <div
                      className={[
                        "max-w-[80%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap",
                        m.role === "user"
                          ? "rounded-br-sm bg-teal-600 text-white"
                          : "rounded-bl-sm bg-slate-800 text-slate-200",
                      ].join(" ")}
                    >
                      {m.content || (
                        <span className="flex items-center gap-1.5 opacity-60">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Eva réfléchit…
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-slate-800/60 px-3 py-2.5">
            <form
              onSubmit={e => {
                e.preventDefault();
                void envoyerChat(chatInput);
              }}
              className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-800/80 px-3 py-2"
            >
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Message à Eva…"
                disabled={chatEnCours}
                className="flex-1 bg-transparent text-[12px] text-slate-100 placeholder-slate-600 outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatEnCours}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-600 text-white transition hover:bg-teal-500 disabled:opacity-30"
              >
                {chatEnCours ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* ── POIGNÉE + DROITE noVNC — masqués en mode embarqué ──────────── */}
      {!embedded && (
        <>
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
                    mediview.ch
                  </span>
                  <span className="truncate text-slate-400">
                    {routeAffichee}
                  </span>
                </button>
              )}

              <a
                href={`https://mediview.ch${routeAffichee}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                title="Ouvrir dans MediView"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <a
                href={`https://mediview.ch${routeAffichee}`}
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
        </>
      )}
    </div>
  );
}
