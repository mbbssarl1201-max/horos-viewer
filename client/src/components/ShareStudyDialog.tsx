import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface Props {
  studyId: number | null;
  open: boolean;
  onClose: () => void;
}

/** Partage INTERNE d'une étude : transmet à un confrère MediView (notification). */
export default function ShareStudyDialog({ studyId, open, onClose }: Props) {
  const users = trpc.users.listClinical.useQuery(undefined, { enabled: open });
  const share = trpc.studies.share.useMutation();
  const [recipient, setRecipient] = useState<number | "">("");
  const [note, setNote] = useState("");
  if (!open || studyId == null) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg p-4 w-[360px] space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-bold text-sm">Partager l'étude</h3>
        <p className="text-[11px] text-muted-foreground">
          Transmettre à un confrère MediView (interne, audité).
        </p>
        <select
          className="w-full bg-muted/40 border border-border rounded text-sm px-2 py-1"
          value={recipient}
          onChange={e =>
            setRecipient(e.target.value ? Number(e.target.value) : "")
          }
        >
          <option value="">Choisir un destinataire…</option>
          {(users.data ?? []).map(u => (
            <option key={u.id} value={u.id}>
              {u.name || u.email || `#${u.id}`} ({u.role})
            </option>
          ))}
        </select>
        <textarea
          className="w-full bg-muted/40 border border-border rounded text-sm px-2 py-1"
          rows={3}
          placeholder="Note (facultative)…"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            size="sm"
            disabled={recipient === "" || share.isPending}
            onClick={async () => {
              try {
                await share.mutateAsync({
                  studyId,
                  recipientUserId: Number(recipient),
                  note: note || undefined,
                });
                toast.success("Étude transmise.");
                setNote("");
                setRecipient("");
                onClose();
              } catch {
                toast.error("Échec du partage.");
              }
            }}
          >
            {share.isPending ? "Envoi…" : "Partager"}
          </Button>
        </div>
      </div>
    </div>
  );
}
