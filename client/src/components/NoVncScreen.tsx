// client/src/components/NoVncScreen.tsx
// Écran noVNC (navigateur Selenium piloté par Eva), rendu DIRECTEMENT dans le
// client — remplace l'ancienne iframe /api/cockpit/viewer dont le HTML servi
// importait RFB depuis un CDN externe (URL morte → « Connexion au navigateur
// en direct… » éternel, et dépendance extérieure contraire au self-hosted).
// RFB est bundlé depuis @novnc/novnc et se connecte au proxy WS même-origine
// /api/cockpit/vnc-ws (auth session + Origin + RBAC côté serveur ; view-only).
// PHI-safe : le flux vidéo montre notre propre app, rien ne part ailleurs.
import { useEffect, useRef, useState } from "react";

interface RfbLike {
  viewOnly: boolean;
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  addEventListener(type: string, cb: () => void): void;
}

export default function NoVncScreen({ className }: { className?: string }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(
    "Connexion au navigateur piloté…"
  );

  useEffect(() => {
    let rfb: RfbLike | null = null;
    let disposed = false;
    let connected = false;
    // Story 3.2 : sans feedback d'échec, l'utilisateur croit que « ça charge »
    // indéfiniment. Si la connexion n'aboutit pas en 15 s, message explicite.
    const timeout = setTimeout(() => {
      if (!disposed && !connected)
        setStatus(
          "Le navigateur piloté ne répond pas (délai dépassé). Vérifiez que le service Selenium est démarré, puis refermez et rouvrez la vue."
        );
    }, 15_000);
    void (async () => {
      try {
        // Import dynamique : RFB ne pèse sur aucun chunk tant que la vue
        // pilotée n'est pas ouverte.
        const { default: RFB } = (await import("@novnc/novnc")) as {
          default: new (target: HTMLElement, url: string) => RfbLike;
        };
        if (disposed || !screenRef.current) return;
        const wsUrl =
          location.origin.replace(/^http/, "ws") + "/api/cockpit/vnc-ws";
        const r = new RFB(screenRef.current, wsUrl);
        r.viewOnly = true;
        r.scaleViewport = true;
        r.background = "#0b1220";
        r.addEventListener("connect", () => {
          connected = true;
          clearTimeout(timeout);
          if (!disposed) setStatus(null);
        });
        r.addEventListener("disconnect", () => {
          clearTimeout(timeout);
          if (!disposed)
            setStatus(
              connected
                ? "Déconnecté du navigateur piloté — refermez puis rouvrez la vue pour retenter."
                : "Impossible de se connecter au navigateur piloté (service indisponible). Refermez et rouvrez la vue pour retenter."
            );
        });
        rfb = r;
      } catch (e) {
        clearTimeout(timeout);
        if (!disposed)
          setStatus(
            "Écran piloté indisponible : " +
              (e instanceof Error ? e.message : String(e))
          );
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      try {
        rfb?.disconnect();
      } catch {
        /* déjà fermé */
      }
    };
  }, []);

  return (
    <div className={`relative bg-[#0b1220] ${className ?? ""}`}>
      <div ref={screenRef} className="absolute inset-0" />
      {status && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="px-6 text-center text-sm text-teal-300">{status}</p>
        </div>
      )}
    </div>
  );
}
