import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import KnowledgePage from "@/pages/KnowledgePage";
import KnowledgeSearchPage from "@/pages/KnowledgeSearchPage";
import CockpitMediView from "@/pages/CockpitMediView";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Viewer from "./pages/Viewer";

// Selenium browse horos.mbbssarl.ch → worklist ; users visit mediview.ch → cockpit
const isSeleniumTarget =
  typeof window !== "undefined" &&
  window.location.hostname === "horos.mbbssarl.ch";

function Router() {
  return (
    <Switch>
      <Route path={"/login"} component={Login} />
      <Route path={"/"}>
        {() => (isSeleniumTarget ? <Home /> : <CockpitMediView />)}
      </Route>
      <Route path={"/worklist"} component={Home} />
      <Route path={"/viewer/:studyId?"} component={Viewer} />
      <Route path={"/404"} component={NotFound} />
      <Route path={"/admin/knowledge"} component={KnowledgePage} />
      <Route path={"/knowledge"} component={KnowledgeSearchPage} />
      <Route path={"/cockpit"}>{() => <CockpitMediView />}</Route>
      <Route component={NotFound} />
    </Switch>
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
