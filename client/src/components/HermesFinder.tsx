import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Search } from "lucide-react";

interface Props {
  onOpen: (studyId: number) => void;
}

export function HermesFinder({ onOpen }: Props) {
  const [query, setQuery] = useState("");
  const enabled = query.trim().length > 1;
  const q = trpc.hermes.findPatientReport.useQuery({ query }, { enabled });
  const results = q.data?.results ?? [];

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <Search className="w-3 h-3" />
        Demander à Hermès
      </h3>
      <input
        className="w-full rounded bg-muted/40 border border-border px-2 py-1 text-sm"
        placeholder="Le dossier de… (nom du patient)"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {enabled && (
        <ul className="divide-y divide-border">
          {q.isLoading && (
            <li className="py-2 text-[11px] text-muted-foreground">
              Recherche…
            </li>
          )}
          {!q.isLoading && results.length === 0 && (
            <li className="py-2 text-[11px] text-muted-foreground">
              Aucun patient trouvé.
            </li>
          )}
          {results.map(r => (
            <li
              key={r.patientId}
              className="flex items-center justify-between gap-2 py-2"
            >
              <div className="text-sm min-w-0">
                <div className="font-medium truncate">{r.patientName}</div>
                <div className="text-[11px] text-muted-foreground">
                  {r.studyId
                    ? r.reportStatus === "signed"
                      ? "CR signé"
                      : r.reportStatus === "draft"
                        ? "Brouillon de CR"
                        : "Pas encore de CR"
                    : "Aucune étude"}
                </div>
              </div>
              {r.studyId != null && (
                <button
                  className="text-[10px] rounded bg-primary/15 text-primary px-2 py-0.5 shrink-0 hover:bg-primary/25 transition-colors"
                  onClick={() => onOpen(r.studyId as number)}
                >
                  Ouvrir
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
