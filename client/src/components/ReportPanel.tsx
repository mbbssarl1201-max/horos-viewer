import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

export interface ReportKeyImage {
  pngBase64: string;
  sliceIndex: number;
  measurements?: string;
}

interface ReportPanelProps {
  studyId: number;
  seriesId: number;
  windowWidth: number;
  windowCenter: number;
  keyImages: ReportKeyImage[];
  onRemoveKeyImage: (index: number) => void;
  onClose: () => void;
}

export default function ReportPanel({
  studyId,
  seriesId,
  windowWidth,
  windowCenter,
  keyImages,
  onRemoveKeyImage,
  onClose,
}: ReportPanelProps) {
  const [to, setTo] = useState("");
  const [signature, setSignature] = useState("");
  const [antecedents, setAntecedents] = useState("");
  const [indication, setIndication] = useState("");
  const [technique, setTechnique] = useState("");
  const [resultats, setResultats] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [includeVideo, setIncludeVideo] = useState(true);
  const [message, setMessage] = useState("");

  const send = trpc.email.sendStudyReport.useMutation();
  const preanalyze = trpc.email.aiPreanalysis.useMutation();
  const [aiAssisted, setAiAssisted] = useState(false);

  const runPreanalysis = async () => {
    const res = await preanalyze.mutateAsync({
      studyId,
      keyImages: keyImages.map(k => ({
        pngBase64: k.pngBase64,
        sliceIndex: k.sliceIndex,
      })),
      indication: indication || undefined,
      antecedents: antecedents || undefined,
    });
    if (res.technique) setTechnique(res.technique);
    setResultats(res.resultats);
    setConclusion(res.conclusion);
    setAiAssisted(true);
  };

  // Lancement AUTOMATIQUE de la pré-analyse à l'ouverture : dès qu'au moins une
  // image clé est disponible (capturée auto par le bouton « Compte rendu »), on
  // génère le brouillon une seule fois, sans clic. Fail-soft : en cas d'échec,
  // le médecin peut relancer via le bouton « Pré-analyse IA ».
  const autoRan = useRef(false);
  useEffect(() => {
    if (
      !autoRan.current &&
      keyImages.length > 0 &&
      !aiAssisted &&
      !preanalyze.isPending
    ) {
      autoRan.current = true;
      void runPreanalysis().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyImages.length]);

  const submit = async () => {
    await send.mutateAsync({
      to,
      studyId,
      seriesId,
      report: { indication, technique, resultats, conclusion },
      signature,
      windowWidth,
      windowCenter,
      keyImages,
      includeVideo,
      message: message || undefined,
      aiAssisted,
      antecedents: antecedents || undefined,
    });
  };

  const field =
    "w-full rounded bg-muted/40 border border-border px-2 py-1 text-sm";
  return (
    <div className="absolute right-0 top-0 z-30 h-full w-[360px] bg-background border-l border-border p-4 overflow-y-auto space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">Compte rendu</h3>
        <button onClick={onClose} className="text-xs text-muted-foreground">
          Fermer
        </button>
      </div>

      <input
        className={field}
        placeholder="Email du confrère"
        value={to}
        onChange={e => setTo(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Antécédents médicaux (optionnel)"
        value={antecedents}
        onChange={e => setAntecedents(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Indication"
        value={indication}
        onChange={e => setIndication(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Technique"
        value={technique}
        onChange={e => setTechnique(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Résultats / Conclusion</span>
        <button
          type="button"
          onClick={runPreanalysis}
          disabled={preanalyze.isPending || keyImages.length === 0}
          className="text-[11px] rounded bg-primary/15 text-primary px-2 py-1 disabled:opacity-50"
          title="Pré-remplir via l'IA locale à partir des images clés"
        >
          {preanalyze.isPending ? "Analyse en cours…" : "Pré-analyse IA"}
        </button>
      </div>
      {aiAssisted && (
        <p className="text-[10px] text-amber-500">
          Brouillon généré par IA — à valider et corriger avant signature.
        </p>
      )}
      {preanalyze.isError && (
        <p className="text-[10px] text-destructive">
          IA indisponible, rédigez manuellement.
        </p>
      )}
      <textarea
        className={field}
        rows={5}
        placeholder="Résultats"
        value={resultats}
        onChange={e => setResultats(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Conclusion"
        value={conclusion}
        onChange={e => setConclusion(e.target.value)}
      />

      <div>
        <div className="text-xs font-medium mb-1">
          Images clés ({keyImages.length})
        </div>
        <div className="flex flex-wrap gap-2">
          {keyImages.map((k, i) => (
            <div key={i} className="relative">
              <img
                src={`data:image/png;base64,${k.pngBase64}`}
                className="w-16 h-16 object-cover rounded border border-border"
                alt={`coupe ${k.sliceIndex + 1}`}
              />
              <button
                onClick={() => onRemoveKeyImage(i)}
                className="absolute -top-1 -right-1 bg-destructive text-white rounded-full w-4 h-4 text-[10px] leading-none"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Utilisez « Ajouter l'image » dans la barre d'outils pour capturer la
          coupe courante.
        </p>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={includeVideo}
          onChange={e => setIncludeVideo(e.target.checked)}
        />
        Inclure le ciné MP4 de toute la série
      </label>

      <input
        className={field}
        placeholder="Signature (nom du médecin)"
        value={signature}
        onChange={e => setSignature(e.target.value)}
      />
      <textarea
        className={field}
        rows={2}
        placeholder="Message (optionnel)"
        value={message}
        onChange={e => setMessage(e.target.value)}
      />

      <button
        onClick={submit}
        disabled={send.isPending || !to || !signature}
        className="w-full rounded bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-50"
      >
        {send.isPending ? "Génération et envoi…" : "Envoyer au confrère"}
      </button>
      {send.isError && (
        <p className="text-xs text-destructive">{send.error.message}</p>
      )}
      {send.isSuccess && (
        <p className="text-xs text-green-500">Compte rendu envoyé.</p>
      )}
    </div>
  );
}
