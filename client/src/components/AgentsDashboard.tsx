import { trpc } from "@/lib/trpc";

export function AgentsDashboard() {
  const list = trpc.agentsRegistry.list.useQuery();
  const suggestions = trpc.agentsRegistry.suggestions.useQuery();
  const configure = trpc.agentsRegistry.configure.useMutation({
    onSuccess: () => list.refetch(),
  });
  const refresh = trpc.agentsRegistry.refreshSuggestions.useMutation({
    onSuccess: () => suggestions.refetch(),
  });
  const resolve = trpc.agentsRegistry.resolveSuggestion.useMutation({
    onSuccess: () => suggestions.refetch(),
  });
  const agents = list.data?.agents ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">Agents Hermès</h3>
        <button
          className="text-[11px] rounded bg-muted/50 px-2 py-1"
          onClick={() => refresh.mutate()}
        >
          Analyser
        </button>
      </div>
      {agents.map((a: any) => (
        <div
          key={a.spec.key}
          className="rounded border border-border p-2 space-y-1"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{a.spec.name}</span>
            <label className="text-[11px] flex items-center gap-1">
              <input
                type="checkbox"
                checked={a.state?.enabled ?? false}
                onChange={e =>
                  configure.mutate({
                    agentKey: a.spec.key,
                    enabled: e.target.checked,
                  })
                }
              />
              actif
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">{a.spec.role}</p>
          <div className="text-[11px]">
            Outils : {a.spec.tools.join(", ")} · Accès :{" "}
            {a.spec.access.join(", ")}
          </div>
          <div className="flex flex-wrap gap-2">
            {a.kpis.map((k: any) => (
              <span
                key={k.key}
                className={`text-[11px] rounded px-1.5 py-0.5 ${k.onTarget ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-500"}`}
              >
                {k.label} : {k.value}
                {k.unit} / {k.target}
                {k.unit}
              </span>
            ))}
          </div>
          <ul className="text-[10px] text-muted-foreground list-disc pl-4">
            {a.spec.guardrails.map((g: string) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ))}
      {(suggestions.data?.items ?? []).length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold">Suggestions d'amélioration</h4>
          {(suggestions.data?.items ?? []).map((s: any) => (
            <div
              key={s.id}
              className="rounded border border-amber-500/40 p-2 text-[11px] space-y-1"
            >
              <div>{s.suggestion}</div>
              <div className="flex gap-2">
                <button
                  className="rounded bg-emerald-500/15 text-emerald-400 px-2 py-0.5"
                  onClick={() =>
                    resolve.mutate({ id: s.id, action: "approved" })
                  }
                >
                  Approuver
                </button>
                <button
                  className="rounded bg-muted/50 px-2 py-0.5"
                  onClick={() =>
                    resolve.mutate({ id: s.id, action: "dismissed" })
                  }
                >
                  Ignorer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
