import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * Page admin : base de connaissances Hermès (RAG). Upload de fichiers .md →
 * ingestion (chunks + embeddings locaux). NON-PHI. Accès admin (knowledge.*
 * sont des adminProcedure ; le serveur refuse les non-admins).
 */
export default function KnowledgePage() {
  const stats = trpc.knowledge.stats.useQuery();
  const ingest = trpc.knowledge.ingest.useMutation();
  const clear = trpc.knowledge.clear.useMutation();
  const [msg, setMsg] = useState("");

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setMsg("Lecture des fichiers…");
    const files: { name: string; content: string }[] = [];
    for (const f of Array.from(fileList)) {
      files.push({ name: f.name, content: await f.text() });
    }
    setMsg(`Ingestion de ${files.length} fichier(s)…`);
    try {
      const r = await ingest.mutateAsync({ files });
      setMsg(
        `Ingéré : ${r.inserted} chunk(s)` +
          (r.errors.length ? ` — ${r.errors.length} erreur(s)` : "")
      );
      stats.refetch();
    } catch {
      setMsg("Échec de l'ingestion.");
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-xl font-bold">Base de connaissances Hermès</h1>
      <p className="text-sm text-muted-foreground">
        Téléversez des fichiers Markdown (.md) de votre coffre Obsidian. Données
        de connaissances uniquement — <strong>aucune donnée patient</strong>.
      </p>
      <div className="text-sm">
        Base actuelle : <strong>{stats.data?.chunks ?? 0}</strong> chunk(s),{" "}
        <strong>{stats.data?.sources ?? 0}</strong> source(s).
      </div>
      <input
        type="file"
        accept=".md,text/markdown"
        multiple
        onChange={e => void onFiles(e.target.files)}
        disabled={ingest.isPending}
      />
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={clear.isPending}
          onClick={async () => {
            if (!confirm("Vider toute la base de connaissances ?")) return;
            await clear.mutateAsync({});
            setMsg("Base vidée.");
            stats.refetch();
          }}
        >
          Vider la base
        </Button>
      </div>
      {msg && <div className="text-xs text-cyan-400">{msg}</div>}
    </div>
  );
}
