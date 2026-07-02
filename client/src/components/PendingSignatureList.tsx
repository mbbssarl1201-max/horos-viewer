import { trpc } from "@/lib/trpc";
import { ClipboardList } from "lucide-react";

interface Props {
  onOpen: (studyId: number) => void;
}

export function PendingSignatureList({ onOpen }: Props) {
  const q = trpc.reports.pendingSignature.useQuery();

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  const items = q.data?.items ?? [];

  if (!items.length)
    return (
      <p className="text-[11px] text-muted-foreground">
        Aucun brouillon en attente.
      </p>
    );

  return (
    <div className="space-y-1">
      <h3 className="text-[10px] font-bold text-amber-400 flex items-center gap-1">
        <ClipboardList className="w-3 h-3" />
        File à signer ({items.length})
      </h3>
      <ul className="divide-y divide-border">
        {items.map(it => (
          <li
            key={it.reportId}
            className="flex items-start justify-between gap-2 py-1.5"
          >
            <div className="text-[10px] min-w-0">
              <div className="font-medium text-foreground truncate">
                {it.studyDescription || `Étude ${it.studyId}`}
              </div>
              <div className="text-muted-foreground">
                {it.modality || "?"} · {it.studyDate || ""}
              </div>
              <div className="text-[9px] text-amber-500">
                Brouillon IA — à valider · réf.{" "}
                {it.referringPhysician || "à renseigner"}
              </div>
            </div>
            <button
              className="text-[10px] rounded bg-primary/15 text-primary px-2 py-0.5 shrink-0 hover:bg-primary/25 transition-colors"
              onClick={() => onOpen(it.studyId)}
            >
              Ouvrir
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
