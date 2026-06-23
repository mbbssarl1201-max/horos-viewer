import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

export function AgentCrSettings() {
  const statusQ = trpc.agent.status.useQuery();
  const configure = trpc.agent.configure.useMutation({
    onSuccess: () => {
      statusQ.refetch();
      toast.success("Réglages agent mis à jour");
    },
    onError: err => toast.error(err.message),
  });

  const [capInput, setCapInput] = useState<string>("");

  const status = statusQ.data;

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        Agent CR autonome
      </h3>

      {statusQ.isLoading ? (
        <p className="text-[10px] text-muted-foreground">Chargement…</p>
      ) : (
        <>
          {/* Toggle activé/désactivé */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-foreground">
              {status?.enabled ? "Activé" : "Désactivé"}
            </span>
            <button
              onClick={() => configure.mutate({ enabled: !status?.enabled })}
              disabled={configure.isPending}
              className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
                status?.enabled ? "bg-emerald-600" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
                  status?.enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {/* Plafond journalier */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground shrink-0">
              Plafond/jour
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={
                capInput !== "" ? capInput : (status?.dailyCap ?? 10).toString()
              }
              onChange={e => setCapInput(e.target.value)}
              onBlur={() => {
                const n = parseInt(capInput, 10);
                if (!isNaN(n) && n > 0) {
                  configure.mutate({ dailyCap: n });
                  setCapInput("");
                }
              }}
              className="w-16 px-1.5 py-0.5 rounded bg-background border border-border text-[10px] text-foreground"
            />
          </div>

          {/* Statut temps réel */}
          <div className="text-[9px] text-muted-foreground space-y-0.5">
            <div>
              Générés aujourd'hui :{" "}
              <span className="text-foreground font-medium">
                {status?.generatedToday ?? 0}
              </span>{" "}
              / {status?.dailyCap ?? "—"}
            </div>
            <div>
              En attente de signature :{" "}
              <span className="text-amber-400 font-medium">
                {status?.pendingCount ?? 0}
              </span>
            </div>
          </div>

          {/* Avertissement réglementaire */}
          <p className="text-[9px] text-amber-500/80 leading-tight">
            N'envoie jamais sans signature du médecin.
          </p>
        </>
      )}
    </div>
  );
}
