import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Mode = "login" | "register";

export default function Login() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onAuthed = async () => {
    await utils.auth.me.invalidate();
    navigate("/");
  };

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: onAuthed,
    onError: e => setError(e.message),
  });
  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: onAuthed,
    onError: e => setError(e.message),
  });

  const pending = loginMutation.isPending || registerMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "login") {
      loginMutation.mutate({ email, password });
    } else {
      registerMutation.mutate({ email, password, name: name || undefined });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>MediView</CardTitle>
          <CardDescription>
            {mode === "login"
              ? "Connectez-vous pour accéder au visualiseur DICOM"
              : "Créer un compte"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="name">Nom</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Dr Jean Dupont"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={mode === "register" ? 8 : undefined}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
              {mode === "register" && (
                <p className="text-xs text-muted-foreground">
                  Au moins 8 caractères.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={pending}>
              {pending
                ? "Veuillez patienter…"
                : mode === "login"
                  ? "Se connecter"
                  : "Créer le compte"}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            {mode === "login" ? (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMode("register");
                  setError(null);
                }}
              >
                Pas encore de compte ? S'inscrire
              </button>
            ) : (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
              >
                Déjà un compte ? Se connecter
              </button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
