import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ClipboardList, Loader2, Search, AlertCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";

interface WorklistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Worklist DICOM (MWL) — affichage en lecture seule des actes programmés
 * interrogés via Orthanc. Fail-soft : si le PACS de démonstration n'a pas de
 * worklist configurée, on affiche « Worklist indisponible » sans casser l'app.
 */
export default function WorklistDialog({
  open,
  onOpenChange,
}: WorklistDialogProps) {
  const [aet, setAet] = useState("");
  const [patientName, setPatientName] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [entries, setEntries] = useState<
    {
      patientName: string;
      patientId: string;
      accessionNumber: string;
      modality: string;
      scheduledDateTime: string;
      procedureDescription: string;
      performingPhysician: string;
    }[]
  >([]);

  const worklist = trpc.orthanc.worklist.useMutation();

  const handleSearch = async () => {
    if (!aet.trim()) return;
    setUnavailable(false);
    try {
      const res = await worklist.mutateAsync({
        aet: aet.trim(),
        patientName: patientName.trim() || undefined,
      });
      if (!res.available) {
        setUnavailable(true);
        setEntries([]);
        return;
      }
      setEntries(res.entries as any);
    } catch {
      // Tout échec réseau/serveur est traité comme « indisponible » (fail-soft).
      setUnavailable(true);
      setEntries([]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4" />
            Worklist DICOM (actes programmés)
          </DialogTitle>
          <DialogDescription>
            Interrogation d'une Modality Worklist via Orthanc (lecture seule).
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="wl-aet" className="text-xs">
              AE Title de la worklist
            </Label>
            <Input
              id="wl-aet"
              value={aet}
              onChange={e => setAet(e.target.value)}
              placeholder="ex. WORKLIST"
              maxLength={16}
            />
          </div>
          <div className="flex-1">
            <Label htmlFor="wl-patient" className="text-xs">
              Nom du patient (optionnel)
            </Label>
            <Input
              id="wl-patient"
              value={patientName}
              onChange={e => setPatientName(e.target.value)}
              placeholder="DOE^JANE"
            />
          </div>
          <Button
            onClick={handleSearch}
            disabled={!aet.trim() || worklist.isPending}
          >
            {worklist.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            <span className="ml-1">Interroger</span>
          </Button>
        </div>

        {unavailable && (
          <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Worklist indisponible (aucune Modality Worklist configurée sur ce
            PACS, ou AE Title incorrect).
          </div>
        )}

        {!unavailable && entries.length === 0 && worklist.isSuccess && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Aucun acte programmé trouvé.
          </p>
        )}

        {entries.length > 0 && (
          <div className="max-h-[50vh] overflow-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Patient</th>
                  <th className="px-2 py-1.5 font-medium">ID</th>
                  <th className="px-2 py-1.5 font-medium">N° accès</th>
                  <th className="px-2 py-1.5 font-medium">Modalité</th>
                  <th className="px-2 py-1.5 font-medium">Programmé</th>
                  <th className="px-2 py-1.5 font-medium">Procédure</th>
                  <th className="px-2 py-1.5 font-medium">Médecin</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr
                    key={i}
                    className="border-t border-border hover:bg-accent/40"
                  >
                    <td className="px-2 py-1.5">{e.patientName || "—"}</td>
                    <td className="px-2 py-1.5">{e.patientId || "—"}</td>
                    <td className="px-2 py-1.5">{e.accessionNumber || "—"}</td>
                    <td className="px-2 py-1.5">{e.modality || "—"}</td>
                    <td className="px-2 py-1.5">
                      {e.scheduledDateTime || "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.procedureDescription || "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.performingPhysician || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
