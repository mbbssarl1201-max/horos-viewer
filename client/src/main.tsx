import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

// Garde « chunk périmé » (obligatoire avec les routes lazy — cf. App.tsx) :
// après un déploiement, les chunks sont renommés (hash) ; une session ouverte
// qui navigue vers une route lazy demande alors un chunk disparu → Vite émet
// `vite:preloadError`. On recharge UNE fois pour récupérer le nouvel index.html
// (drapeau sessionStorage contre les boucles si le reload ne suffit pas).
window.addEventListener("vite:preloadError", event => {
  event.preventDefault(); // évite l'erreur non gérée pendant qu'on recharge
  const FLAG = "mv-chunk-reload";
  if (sessionStorage.getItem(FLAG)) return; // déjà tenté → laisser l'UI d'erreur
  sessionStorage.setItem(FLAG, "1");
  window.location.reload();
});
window.addEventListener("load", () => {
  // Page chargée avec succès → réarmer la garde pour le prochain déploiement.
  sessionStorage.removeItem("mv-chunk-reload");
});

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
