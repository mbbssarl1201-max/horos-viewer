// client/src/pages/CockpitMediView.tsx
//
// COCKPIT écran scindé MediView : navigation (gauche) + navigateur Selenium live (droite).
// Le panneau droit affiche un flux noVNC via /api/cockpit/viewer (même-origine).
// La navigation Selenium passe par /api/cockpit/naviguer (POST protégé).
//
// PHI-safe : le navigateur Selenium tourne sur le VPS, aucune donnée ne quitte
// le périmètre de confiance.
import { useRef, useState } from "react";
import {
  Home,
  BookOpen,
  Search,
  Loader2,
  RotateCcw,
  Maximize2,
  MonitorPlay,
  ChevronRight,
} from "lucide-react";

const VIEWER_URL = "/api/cockpit/viewer";

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

export default function CockpitMediView() {
  const [routeAffichee, setRouteAffichee] = useState("/");
  const [navEnCours, setNavEnCours] = useState(false);
  const [saisieRoute, setSaisieRoute] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const naviguer = (route: string) => {
    setRouteAffichee(route);
    setNavEnCours(true);
    void naviguerSelenium(route).finally(() => setNavEnCours(false));
  };

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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 dark:bg-slate-950">
      {/* ── GAUCHE : panneau de navigation Eva ──────────────────────────── */}
      <aside className="flex w-[320px] min-w-[260px] max-w-[28vw] flex-col bg-white shadow-xl dark:bg-slate-900">
        {/* En-tête */}
        <header className="flex items-center gap-3 bg-gradient-to-br from-violet-700 to-violet-900 px-4 py-3.5 text-white">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 ring-2 ring-white/40">
            <MonitorPlay className="h-6 w-6 text-white" />
          </div>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-tight">
              MediView Cockpit
            </p>
            <p className="text-xs text-violet-200/80">
              Navigation Selenium en direct
            </p>
          </div>
        </header>

        {/* Raccourcis */}
        <div className="flex-1 overflow-y-auto px-4 py-5">
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

          <div className="mt-6 rounded-xl bg-violet-50 px-4 py-3 text-xs text-violet-700 dark:bg-violet-950/30 dark:text-violet-300">
            Le navigateur Selenium (panneau droit) navigue en temps réel sur
            MediView. Cliquez un raccourci ou saisissez une route pour le
            piloter.
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
