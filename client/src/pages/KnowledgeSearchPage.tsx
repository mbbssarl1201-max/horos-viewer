import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

interface Result {
  source: string;
  heading: string | null;
  content: string;
  score: number;
}

/**
 * Recherche sémantique dans la base de connaissances Hermès (lecture seule).
 * Accès clinique (knowledge.searchPublic = medicalProcedure). NON-PHI.
 */
export default function KnowledgeSearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const search = trpc.knowledge.searchPublic.useMutation();

  const run = async () => {
    const q = query.trim();
    if (!q || search.isPending) return;
    try {
      const r = await search.mutateAsync({ query: q, k: 8 });
      setResults(r.results);
    } catch {
      setResults([]);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-xl font-bold">Recherche — connaissances Hermès</h1>
      <p className="text-sm text-muted-foreground">
        Recherche sémantique dans la base de connaissances radiologiques.
        Connaissances de référence — <strong>aucune donnée patient</strong>.
      </p>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded bg-muted/40 border border-border px-2 py-1 text-sm"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="ex. rehaussement annulaire, protocole IRM…"
        />
        <Button
          size="sm"
          disabled={search.isPending || !query.trim()}
          onClick={() => void run()}
        >
          Rechercher
        </Button>
      </div>
      {search.isPending && (
        <div className="text-xs text-cyan-400">Recherche…</div>
      )}
      {!search.isPending && results.length === 0 && query && (
        <div className="text-xs text-muted-foreground">
          Aucun extrait pertinent.
        </div>
      )}
      <div className="space-y-3">
        {results.map((r, i) => (
          <div key={i} className="border border-border rounded p-2 text-sm">
            <div className="text-[11px] text-muted-foreground">
              {r.source}
              {r.heading ? ` › ${r.heading}` : ""} · {r.score.toFixed(2)}
            </div>
            <div className="whitespace-pre-wrap mt-1">{r.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
