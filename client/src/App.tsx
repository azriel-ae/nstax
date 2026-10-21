import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

// NSTAX V2 dimuat lazy: kode V2 tidak masuk bundle halaman utama.
const V2App = lazy(() => import("./v2/V2App"));
const V2 = () => <Suspense fallback={null}><V2App /></Suspense>;

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/v2"} component={V2} />
      <Route path={"/v2/*?"} component={V2} />
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
