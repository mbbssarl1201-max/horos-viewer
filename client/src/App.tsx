import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import { lazy, Suspense } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Login from "./pages/Login";

// Routes LOURDES en lazy-loading : Viewer tire Cornerstone (~2,9 Mo de JS) et
// vtk.js — les charger dès /login ou la worklist pénalise tout le monde. Le
// chunk n'est téléchargé qu'à la première navigation vers la route. La garde
// « chunk périmé » (vite:preloadError → reload, cf. main.tsx + 404 serveur sur
// /assets manquant) est OBLIGATOIRE avec ce découpage : sans elle, un
// déploiement qui renomme les chunks casse les sessions ouvertes.
const Viewer = lazy(() => import("./pages/Viewer"));
const CockpitMediView = lazy(() => import("@/pages/CockpitMediView"));
const KnowledgePage = lazy(() => import("@/pages/KnowledgePage"));
const KnowledgeSearchPage = lazy(() => import("@/pages/KnowledgeSearchPage"));

// Fallback discret pendant le chargement d'un chunk de route (thème sombre).
export function RouteLoader() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteLoader />}>
      <Switch>
        <Route path={"/login"} component={Login} />
        <Route path={"/"} component={Home} />
        <Route path={"/viewer/:studyId?"} component={Viewer} />
        <Route path={"/404"} component={NotFound} />
        <Route path={"/admin/knowledge"} component={KnowledgePage} />
        <Route path={"/knowledge"} component={KnowledgeSearchPage} />
        <Route path={"/cockpit"}>{() => <CockpitMediView />}</Route>
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
