import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { findBoneSeries, BONE_WINDOW } from "@/lib/boneSeries";
import { REPORT_TEMPLATES } from "@/lib/reportTemplates";

export interface ReportKeyImage {
  pngBase64: string;
  sliceIndex: number;
  measurements?: string;
}

export interface SeriesInfo {
  id: number;
  seriesDescription?: string | null;
  numberOfInstances?: number;
}

interface ReportPanelProps {
  studyId: number;
  seriesId: number;
  windowWidth: number;
  windowCenter: number;
  keyImages: ReportKeyImage[];
  seriesList?: SeriesInfo[];
  onRemoveKeyImage: (index: number) => void;
  onAddKeyImage?: (img: ReportKeyImage) => void;
  comparePriorStudyId?: number | null;
  comparePriorSeriesId?: number | null;
  studyModality?: string | null;
  onClose: () => void;
}

type Sections = {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
};

const SECTION_KEYS = [
  "indication",
  "technique",
  "resultats",
  "conclusion",
] as const;

// Formate une date DICOM DA brute (`YYYYMMDD`) en `JJ.MM.AAAA` pour l'affichage.
// Toute entrée non conforme est renvoyée telle quelle (best-effort).
function formatDicomDate(da: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(da.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : da;
}

export default function ReportPanel({
  studyId,
  seriesId,
  windowWidth,
  windowCenter,
  keyImages,
  seriesList,
  onRemoveKeyImage,
  onAddKeyImage,
  comparePriorStudyId,
  comparePriorSeriesId,
  studyModality,
  onClose,
}: ReportPanelProps) {
  const [to, setTo] = useState("");
  const [antecedents, setAntecedents] = useState("");
  // Les 4 sections du compte-rendu, hydratées depuis le brouillon persisté.
  const [sections, setSections] = useState<Sections>({
    indication: "",
    technique: "",
    resultats: "",
    conclusion: "",
  });
  const [addendumText, setAddendumText] = useState("");
  const [includeVideo, setIncludeVideo] = useState(true);
  const [message, setMessage] = useState("");

  // Assistance Hermès par section : flux en cours + texte précédent (pour ↩).
  const [assistBusy, setAssistBusy] = useState<string | null>(null);
  const [assistPrev, setAssistPrev] = useState<Partial<Sections>>({});

  const runAssist = async (
    field: keyof Sections,
    action: "reformuler" | "structurer" | "conclure" | "terminologie"
  ) => {
    if (assistBusy || isSigned) return;
    // Capture SYNCHRONE du texte précédent (le state React est asynchrone : on ne
    // peut pas se fier à `assistPrev` dans le catch).
    const previousText = sections[field];
    // Pour « conclure », la cible est Conclusion mais le texte source = Résultats.
    const sourceText =
      action === "conclure" ? sections.resultats : sections[field];
    setAssistPrev(p => ({ ...p, [field]: previousText }));
    setAssistBusy(field);
    setSections(s => ({ ...s, [field]: "" }));
    const setField = (updater: (cur: string) => string) =>
      setSections(s => ({ ...s, [field]: updater(s[field]) }));
    try {
      const resp = await fetch("/api/hermes/report-assist/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ studyId, action, currentText: sourceText }),
      });
      if (!resp.ok || !resp.body) throw new Error("no-stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim());
              if (typeof evt.t === "string") setField(c => c + evt.t);
              else if (evt.error) setField(c => c + `\n⚠️ ${evt.error}`);
            } catch {
              /* ignore */
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch {
      // Échec : restaure le texte précédent (capturé synchronement).
      setSections(s => ({ ...s, [field]: previousText }));
      setMessage("Assistant Hermès indisponible.");
    } finally {
      setAssistBusy(null);
    }
  };

  const restoreAssist = (field: keyof Sections) => {
    const prev = assistPrev[field];
    if (prev === undefined) return;
    setSections(s => ({ ...s, [field]: prev }));
    setAssistPrev(p => {
      const { [field]: _drop, ...rest } = p;
      void _drop;
      return rest;
    });
  };

  // --- Compte-rendu persisté (router `reports`) ---------------------------
  const reportQuery = trpc.reports.getByStudy.useQuery({ studyId });
  const upsertDraft = trpc.reports.upsertDraft.useMutation();
  const aiGenerate = trpc.reports.aiGenerate.useMutation();
  const signReport = trpc.reports.sign.useMutation();
  const signAndSend = trpc.reports.signAndSend.useMutation();
  const addAddendum = trpc.reports.addAddendum.useMutation();
  const trpcUtils = trpc.useUtils();

  const report = reportQuery.data?.report ?? null;
  const isSigned = report?.status === "signed";

  // Hydrate les sections locales depuis le compte-rendu persisté (à chaque
  // changement d'identifiant de compte-rendu, ex. création du brouillon).
  useEffect(() => {
    if (report) {
      setSections({
        indication: report.indication ?? "",
        technique: report.technique ?? "",
        resultats: report.resultats ?? "",
        conclusion: report.conclusion ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);

  // --- Pré-analyse IA enrichie (anomalie, coupe-clé) ----------------------
  // Conservée : elle apporte l'indicateur d'anomalie + la désignation de la
  // coupe-clé que le router `reports.aiGenerate` ne renvoie pas. Le bouton
  // « Analyser les fractures » force la série osseuse en fenêtre Bone.
  const preanalyze = trpc.email.aiPreanalysis.useMutation();
  const send = trpc.email.sendStudyReport.useMutation();
  const history = trpc.studies.patientHistory.useQuery({ studyId });

  // --- Pilotage GPU vision (veille/réveil — facturation à l'usage) ---------
  // Le GPU se met en veille après inactivité ; on sonde son état et on propose
  // un bouton « Réveiller l'IA ». state "unknown" = pilotage non configuré →
  // on n'entrave rien (comportement historique : GPU supposé toujours dispo).
  const gpuStatusQ = trpc.ai.gpuStatus.useQuery(undefined, {
    refetchInterval: q => {
      const s = (q.state.data as { state?: string } | undefined)?.state;
      return s === "waking" || s === "starting" ? 4000 : 20000;
    },
  });
  const gpuWake = trpc.ai.gpuWake.useMutation();
  const gpuState = gpuStatusQ.data?.state ?? "unknown";
  const gpuManaged = gpuState !== "unknown";
  const gpuReady = !gpuManaged || gpuState === "ready";

  // --- IA CERTIFIÉE (dispositifs médicaux CE/FDA tiers) --------------------
  // Inventaire des moteurs branchables (pour informer le médecin de ce qui est
  // actif) + lancement d'une analyse certifiée. Tant qu'aucun contrat/clé n'est
  // fourni, l'analyse renvoie « indisponible » et on reste sur l'aide interne.
  const certifiedInventory = trpc.ai.certifiedAiInventory.useQuery();
  const certifiedAnalysis = trpc.ai.certifiedAnalysis.useMutation();
  const certifiedConfigured =
    certifiedInventory.data?.some(p => p.configured && p.phiConsent) ?? false;
  const gpuBusy = gpuState === "waking" || gpuState === "starting";

  // --- Dictée vocale (Whisper GPU, PHI-safe) -------------------------------
  const transcribe = trpc.ai.transcribe.useMutation();
  const [recording, setRecording] = useState(false);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const u8ToBase64 = (u8: Uint8Array) => {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH)
      s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
    return btoa(s);
  };
  const toggleDictation = async () => {
    if (recording) {
      mediaRecRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, {
          type: mr.mimeType || "audio/webm",
        });
        const buf = new Uint8Array(await blob.arrayBuffer());
        if (buf.length === 0) return;
        try {
          const r = await transcribe.mutateAsync({
            audioBase64: u8ToBase64(buf),
            mimeType: blob.type,
          });
          if (r.text)
            setSections(s => ({
              ...s,
              resultats: s.resultats ? `${s.resultats} ${r.text}` : r.text,
            }));
        } catch {
          /* erreur transcription : silencieux, l'utilisateur réessaie */
        }
      };
      mediaRecRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      /* micro refusé/indispo */
    }
  };

  useEffect(() => {
    return () => {
      if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") {
        mediaRecRef.current.stop();
      }
    };
  }, []);

  // --- Mode validation IA : verdict du médecin + stats d'accord -------------
  const aiEval = trpc.ai.evaluation.useQuery({ studyId });
  const aiEvalStats = trpc.ai.evaluationStats.useQuery();
  const recordEval = trpc.ai.recordEvaluation.useMutation();
  // Segmentation CT open-source (TotalSegmentator) sur le GPU.
  const segmentCt = trpc.ai.segmentCt.useMutation();
  // Suggestion de codes CIM-10 (LLM texte) — à valider, facturation = MediAdmin.
  const suggestCodes = trpc.ai.suggestCodes.useMutation();
  // Haute précision (1.5mm) : toujours active (UI simplifiée — plus de case).
  const highResSeg = true;
  // Région à segmenter (corps par défaut ; tête/cou pour scanners de face/crâne).
  const [segTask, setSegTask] = useState<
    | "total"
    | "total_mr"
    | "head_glands_cavities"
    | "headneck_bones_vessels"
    | "brain_structures"
  >("total");
  // Analyse exhaustive (toutes les coupes) — tâche de fond longue, sondée.
  const startExhaustive = trpc.ai.startExhaustive.useMutation();
  const [exhaustiveJob, setExhaustiveJob] = useState<string | null>(null);
  // Panneau simplifié : les outils d'analyse spécialisés (fractures, pré-analyse
  // rapide, segmentation, CR précis) sont repliés — l'action principale est le
  // seul bouton « Analyser (IA) ». Ouvert à la demande.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const exhaustiveDone = useRef(false);
  const exhaustiveStatus = trpc.ai.exhaustiveStatus.useQuery(
    { jobId: exhaustiveJob ?? "" },
    {
      enabled: !!exhaustiveJob,
      refetchInterval: q =>
        (q.state.data as { status?: string } | undefined)?.status === "running"
          ? 4000
          : false,
    }
  );
  useEffect(() => {
    const d = exhaustiveStatus.data as any;
    if (d?.status === "done" && d.result && !exhaustiveDone.current) {
      exhaustiveDone.current = true;
      const r = d.result;
      setSections(s => ({
        indication: s.indication,
        technique: s.technique || r.technique || "",
        resultats: s.resultats || r.resultats,
        conclusion: s.conclusion || r.conclusion,
      }));
      setAiAbnormal(r.abnormal ?? null);
      setAiKeySlice(r.keySliceNumber ?? null);
      setSecondOpinion(r.secondOpinion ?? null);
      setEvolution(r.evolution ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhaustiveStatus.data]);
  const [missedFinding, setMissedFinding] = useState(false);
  useEffect(() => {
    if (aiEval.data) setMissedFinding(aiEval.data.missedFinding);
  }, [aiEval.data]);
  const submitVerdict = async (verdict: "juste" | "partielle" | "fausse") => {
    await recordEval.mutateAsync({ studyId, verdict, missedFinding });
    aiEval.refetch();
    aiEvalStats.refetch();
  };
  const [aiAbnormal, setAiAbnormal] = useState<boolean | null>(null);
  const [aiKeySlice, setAiKeySlice] = useState<number | null>(null);
  // Série réellement analysée (peut différer de la série ouverte, ex. bouton
  // « Analyser les fractures » qui force la série osseuse).
  const [analyzedSeriesId, setAnalyzedSeriesId] = useState<number | null>(null);
  const [evolution, setEvolution] = useState<
    "stable" | "progression" | "regression" | null
  >(null);
  const [comparedPriorDate, setComparedPriorDate] = useState<string | null>(
    null
  );
  // Double lecture (2 modèles) : toujours active (UI simplifiée — plus de case).
  const doubleRead = true;
  const [secondOpinion, setSecondOpinion] = useState<{
    abnormal: boolean | null;
    agree: boolean;
    model: string;
  } | null>(null);

  const runPreanalysis = async (
    antecedentsArg = antecedents,
    override?: {
      seriesId?: number;
      windowCenter?: number;
      windowWidth?: number;
      includeSegmentation?: boolean;
      highResSegmentation?: boolean;
    }
  ) => {
    const sid = override?.seriesId ?? seriesId;
    const wc = override?.windowCenter ?? windowCenter;
    const ww = override?.windowWidth ?? windowWidth;
    const res = await preanalyze.mutateAsync({
      studyId,
      seriesId: sid,
      windowCenter: wc,
      windowWidth: ww,
      keyImages: keyImages.map(k => ({
        pngBase64: k.pngBase64,
        sliceIndex: k.sliceIndex,
      })),
      indication: sections.indication || undefined,
      antecedents: antecedentsArg || undefined,
      // Analyse AUTO (sans override) = MAXIMUM systématique : toute l'étude +
      // approfondie + mesures (segmentation CT) + double lecture + vérif +
      // comparaison antériorités. Les boutons ciblés gardent leur réglage.
      includeSegmentation: override?.includeSegmentation ?? true,
      highResSegmentation: override?.highResSegmentation ?? true,
      doubleRead,
      wholeStudy: !override,
      compareAllPriors: !override,
      deepAnalysis: !override,
    });
    setAnalyzedSeriesId(sid);
    setSecondOpinion(res.secondOpinion ?? null);
    // On ne pré-remplit que les champs vides pour ne pas écraser le médecin.
    setSections(s => ({
      indication: s.indication,
      technique: s.technique || res.technique || "",
      resultats: s.resultats || res.resultats,
      conclusion: s.conclusion || res.conclusion,
    }));
    setAiAbnormal(res.abnormal ?? null);
    setAiKeySlice(res.keySliceNumber ?? null);
    if (
      res.keyImage &&
      onAddKeyImage &&
      !keyImages.some(k => k.sliceIndex === res.keyImage!.sliceIndex)
    ) {
      onAddKeyImage({
        pngBase64: res.keyImage.pngBase64,
        sliceIndex: res.keyImage.sliceIndex,
      });
    }
  };

  // Pré-remplit Antécédents avec l'historique d'imagerie (si encore vide).
  useEffect(() => {
    if (history.data?.antecedents && !antecedents) {
      setAntecedents(history.data.antecedents);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  // Auto-pré-analyse à l'ouverture (une seule fois), si aucun compte-rendu
  // persisté n'existe encore. NE dépend PLUS d'une image clé capturée : le
  // serveur échantillonne toute la série lui-même (seriesId) → l'IA tourne même
  // en 3D/VR ou quand la capture du canvas échoue.
  const autoRan = useRef(false);
  useEffect(() => {
    if (
      !autoRan.current &&
      seriesId != null &&
      history.isFetched &&
      reportQuery.isFetched &&
      !report &&
      !preanalyze.isPending &&
      (studyModality === "CT" || studyModality === "PT")
    ) {
      autoRan.current = true;
      void preanalyze.mutateAsync({
        studyId,
        seriesId,
        windowCenter,
        windowWidth,
        keyImages: [],
        includeSegmentation: false,
        highResSegmentation: false,
        doubleRead: false,
        wholeStudy: true,
        compareAllPriors: true,
        deepAnalysis: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, history.isFetched, reportQuery.isFetched, studyModality]);

  const aiAssisted = aiAbnormal !== null || aiGenerate.data != null;

  const submit = async () => {
    // Contenu et signature serveur-autoritatifs : le serveur rebâtit le PDF
    // depuis le compte-rendu SIGNÉ en DB. On n'envoie plus de sections ni de
    // signature manuelle depuis le client. Cf. audit I1.
    await send.mutateAsync({
      to,
      studyId,
      seriesId,
      windowWidth,
      windowCenter,
      keyImages,
      includeVideo,
      message: message || undefined,
      antecedents: antecedents || undefined,
    });
  };

  const field =
    "w-full rounded bg-muted/40 border border-border px-2 py-1 text-sm";
  // Champs du COMPTE RENDU : plus grands et plus aérés (lisibilité du CR IA).
  const reportField =
    "w-full rounded bg-muted/40 border border-border px-3 py-2 text-[15px] leading-relaxed";
  return (
    <div className="absolute right-0 top-0 z-30 h-full w-full sm:w-[440px] lg:w-[520px] max-w-[100vw] bg-background border-l border-border p-4 overflow-y-auto space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">Compte rendu</h3>
        <button onClick={onClose} className="text-xs text-muted-foreground">
          Fermer
        </button>
      </div>

      {!isSigned && (
        <select
          className={field}
          defaultValue=""
          title="Insère un modèle structuré (remplit les sections vides). N'écrase pas ton texte."
          onChange={e => {
            const t = REPORT_TEMPLATES.find(x => x.id === e.target.value);
            e.currentTarget.selectedIndex = 0;
            if (!t) return;
            setSections(s => ({
              indication: s.indication,
              technique: s.technique || t.sections.technique,
              resultats: s.resultats || t.sections.resultats,
              conclusion: s.conclusion || t.sections.conclusion,
            }));
          }}
        >
          <option value="">Modèle de compte rendu…</option>
          {REPORT_TEMPLATES.map(t => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}

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
        disabled={isSigned}
      />

      {/* --- Éditeur 4 sections ------------------------------------------- */}
      {SECTION_KEYS.map(k => (
        <div key={k} className="space-y-1">
          <label className="text-sm font-semibold capitalize">{k}</label>
          <textarea
            className={reportField}
            rows={k === "resultats" ? 12 : k === "conclusion" ? 5 : 4}
            value={sections[k]}
            disabled={isSigned || assistBusy === k}
            onChange={e => setSections(s => ({ ...s, [k]: e.target.value }))}
          />
          {!isSigned && (
            <div className="flex flex-wrap gap-1 text-[10px]">
              <button
                type="button"
                className="px-1.5 py-0.5 rounded bg-muted/50 hover:bg-muted disabled:opacity-40"
                disabled={assistBusy != null}
                onClick={() => void runAssist(k, "reformuler")}
              >
                ✨ Reformuler
              </button>
              <button
                type="button"
                className="px-1.5 py-0.5 rounded bg-muted/50 hover:bg-muted disabled:opacity-40"
                disabled={assistBusy != null}
                onClick={() => void runAssist(k, "structurer")}
              >
                Structurer
              </button>
              <button
                type="button"
                className="px-1.5 py-0.5 rounded bg-muted/50 hover:bg-muted disabled:opacity-40"
                disabled={assistBusy != null}
                onClick={() => void runAssist(k, "terminologie")}
              >
                Terminologie
              </button>
              {k === "conclusion" && (
                <button
                  type="button"
                  className="px-1.5 py-0.5 rounded bg-muted/50 hover:bg-muted disabled:opacity-40"
                  disabled={assistBusy != null}
                  onClick={() => void runAssist("conclusion", "conclure")}
                >
                  Proposer depuis les résultats
                </button>
              )}
              {assistPrev[k] !== undefined && assistBusy !== k && (
                <button
                  type="button"
                  className="px-1.5 py-0.5 rounded text-amber-500 hover:underline"
                  onClick={() => restoreAssist(k)}
                >
                  ↩ Restaurer
                </button>
              )}
              {assistBusy === k && (
                <span className="text-cyan-400">Hermès rédige…</span>
              )}
            </div>
          )}
        </div>
      ))}

      {aiAssisted && !isSigned && (
        <p className="text-[10px] text-amber-500">
          Brouillon assisté par IA — à valider et corriger avant signature.
        </p>
      )}
      {!isSigned && analyzedSeriesId != null && (
        <p className="text-[10px] text-muted-foreground">
          Analyse basée sur :{" "}
          <span className="font-medium text-foreground">
            {seriesList?.find(s => s.id === analyzedSeriesId)
              ?.seriesDescription || `Série ${analyzedSeriesId}`}
          </span>
          {(() => {
            const n = seriesList?.find(
              s => s.id === analyzedSeriesId
            )?.numberOfInstances;
            return n ? ` (${n} coupes)` : "";
          })()}
        </p>
      )}
      {!isSigned && aiAbnormal !== null && (
        <p
          className={`text-[11px] font-medium ${
            aiAbnormal ? "text-destructive" : "text-green-500"
          }`}
        >
          {aiAbnormal
            ? `⚠ Anomalie possible repérée par l'IA${
                aiKeySlice
                  ? keyImages.some(k => k.sliceIndex === aiKeySlice)
                    ? ` — coupe n° ${aiKeySlice} (ajoutée aux images clés)`
                    : ` — naviguez à la coupe n° ${aiKeySlice} et utilisez « Ajouter l'image »`
                  : ""
              }. À confirmer par le médecin.`
            : "Aucune anomalie manifeste repérée par l'IA (à confirmer)."}
        </p>
      )}
      {(preanalyze.isError || aiGenerate.isError) && !isSigned && (
        <p className="text-[10px] text-destructive">
          {gpuManaged && !gpuReady
            ? "IA en veille — cliquez « Réveiller l'IA » puis relancez."
            : "IA indisponible, rédigez manuellement."}
        </p>
      )}

      {/* --- État du GPU vision (veille/réveil — facturation à l'usage) ---- */}
      {gpuManaged && !isSigned && (
        <div className="flex items-center gap-2 text-[11px]">
          {gpuState === "ready" && (
            <span className="inline-flex items-center gap-1 text-green-500">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              IA prête
            </span>
          )}
          {gpuBusy && (
            <span className="inline-flex items-center gap-1 text-amber-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Réveil de l'IA en cours… (~1–2 min)
            </span>
          )}
          {gpuState === "asleep" && (
            <>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                IA en veille
              </span>
              <button
                type="button"
                disabled={gpuWake.isPending}
                onClick={async () => {
                  await gpuWake.mutateAsync();
                  gpuStatusQ.refetch();
                }}
                className="rounded bg-primary/15 text-primary px-2 py-0.5 disabled:opacity-50"
                title="Sort le GPU de veille (~1–2 min), puis l'IA est rapide"
              >
                {gpuWake.isPending ? "Réveil…" : "Réveiller l'IA"}
              </button>
            </>
          )}
        </div>
      )}

      {/* --- Dictée vocale (Whisper GPU, ajoute aux Résultats) ----------- */}
      {!isSigned && (
        <button
          type="button"
          onClick={toggleDictation}
          disabled={transcribe.isPending}
          className={`text-[11px] rounded px-2 py-1 disabled:opacity-50 ${
            recording
              ? "bg-red-500/20 text-red-400 animate-pulse"
              : "bg-sky-500/15 text-sky-400"
          }`}
          title="Dicter le compte rendu (transcription locale en Suisse). Le texte est ajouté aux Résultats."
        >
          {recording
            ? "⏺ Enregistrement… (cliquer pour arrêter)"
            : transcribe.isPending
              ? "Transcription…"
              : "🎤 Dicter"}
        </button>
      )}

      {/* --- Actions brouillon -------------------------------------------- */}
      {!isSigned && (
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={
              startExhaustive.isPending ||
              (gpuManaged && !gpuReady) ||
              exhaustiveStatus.data?.status === "running"
            }
            onClick={async () => {
              // « Générer (IA) » = analyse EXHAUSTIVE de TOUT le dossier : chaque
              // coupe de chaque série diagnostique (couverture 100 %) + mesures +
              // OCR + re-zoom + double lecture + vérification. Job de fond ; le
              // suivi (barre) remplit le compte rendu à la fin.
              exhaustiveDone.current = false;
              const r = await startExhaustive.mutateAsync({
                studyId,
                seriesId: analyzedSeriesId ?? seriesId,
                windowCenter,
                windowWidth,
                indication: sections.indication || undefined,
                antecedents: antecedents || undefined,
                wholeStudy: true,
              });
              setExhaustiveJob(r.jobId);
            }}
            title="Analyse complète du dossier : sélectionne automatiquement les bonnes séries de coupes, balaye chaque coupe (100 %) + mesures + double lecture + vérification. Plusieurs minutes — ne quitte pas la page."
          >
            {exhaustiveStatus.data?.status === "running"
              ? "Analyse en cours…"
              : "🔬 Analyser (IA)"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={upsertDraft.isPending}
            onClick={async () => {
              await upsertDraft.mutateAsync({
                studyId,
                sections,
                aiGenerated: aiGenerate.data != null,
                aiModel: aiGenerate.data?.aiModel,
              });
              reportQuery.refetch();
            }}
          >
            Enregistrer brouillon
          </Button>
          <Button
            size="sm"
            disabled={!sections.conclusion.trim() || signReport.isPending}
            onClick={async () => {
              const up = await upsertDraft.mutateAsync({ studyId, sections });
              await signReport.mutateAsync({ reportId: up.id });
              reportQuery.refetch();
            }}
          >
            Signer
          </Button>
          <button
            disabled={!sections.conclusion.trim() || signAndSend.isPending}
            onClick={async () => {
              try {
                const up = await upsertDraft.mutateAsync({
                  studyId,
                  sections,
                });
                await signAndSend.mutateAsync({
                  reportId: up.id,
                  recipientEmail: to || undefined,
                  windowCenter,
                  windowWidth,
                });
                reportQuery.refetch();
              } catch (e: unknown) {
                const msg =
                  e instanceof Error ? e.message : "Erreur lors de l'envoi";
                setMessage(msg);
              }
            }}
            className="text-[11px] rounded bg-emerald-600/20 text-emerald-400 px-2 py-1 disabled:opacity-50"
            title="Signe le compte-rendu et l'envoie au médecin référent"
          >
            {signAndSend.isPending ? "Envoi…" : "Signer & envoyer au référent"}
          </button>
        </div>
      )}

      {/* --- Suggestion de codes CIM-10 (à valider ; facturation = MediAdmin) -- */}
      {!isSigned && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={
              suggestCodes.isPending ||
              !(sections.resultats || sections.conclusion).trim()
            }
            onClick={() =>
              suggestCodes.mutate({
                studyId,
                resultats: sections.resultats || "",
                conclusion: sections.conclusion || "",
              })
            }
            className="text-[11px] rounded bg-teal-500/15 text-teal-400 px-2 py-1 disabled:opacity-50"
            title="Propose des codes CIM-10 à partir du compte rendu (à valider ; la facturation se fait dans MediAdmin)."
          >
            {suggestCodes.isPending
              ? "Analyse…"
              : "Suggérer codes (CIM-10 + TARDOC)"}
          </button>
          {/* Indice quand le bouton est inactif : sinon le clic « ne fait rien ». */}
          {!(sections.resultats || sections.conclusion).trim() &&
            !suggestCodes.isPending && (
              <p className="text-[10px] text-muted-foreground">
                Renseignez d'abord les Résultats ou la Conclusion du compte
                rendu pour obtenir des suggestions de codes.
              </p>
            )}
          {/* Échec réseau/serveur : message actionnable (Epic 7). */}
          {suggestCodes.isError && (
            <p className="text-[11px] rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-400">
              Suggestion de codes indisponible (service d'IA local injoignable).
              Réessayez ; si le problème persiste, codez manuellement dans
              MediAdmin.
            </p>
          )}
          {/* Succès mais aucun code : ne pas laisser l'utilisateur sans retour. */}
          {suggestCodes.isSuccess &&
            suggestCodes.data.codes.length === 0 &&
            suggestCodes.data.tardoc.length === 0 && (
              <p className="text-[11px] rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-500">
                Aucun code n'a pu être proposé pour ce compte rendu. Vérifiez
                que le service d'IA local est actif, ou codez dans MediAdmin.
              </p>
            )}
          {suggestCodes.data && suggestCodes.data.codes.length > 0 && (
            <div className="text-[11px] rounded border border-teal-500/30 p-2 space-y-0.5">
              <p className="text-[10px] text-muted-foreground">
                Codes suggérés (à VÉRIFIER, reporter dans la facturation) :
              </p>
              {suggestCodes.data.codes.map(c => (
                <div key={c.code} className="flex gap-2">
                  <span className="font-mono text-teal-400">{c.code}</span>
                  <span className="text-muted-foreground">{c.label}</span>
                </div>
              ))}
            </div>
          )}
          {suggestCodes.data && suggestCodes.data.tardoc.length > 0 && (
            <div className="text-[11px] rounded border border-indigo-500/30 p-2 space-y-0.5">
              <p className="text-[10px] text-muted-foreground">
                Actes TARDOC suggérés (à VÉRIFIER ; facturation = MediAdmin) :
              </p>
              {suggestCodes.data.tardoc.map(c => (
                <div key={c.code} className="flex gap-2">
                  <span className="font-mono text-indigo-400">{c.code}</span>
                  <span className="text-muted-foreground">{c.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isSigned && evolution && (
        <div
          className={
            "mt-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium " +
            (evolution === "stable"
              ? "bg-green-500/15 text-green-400"
              : evolution === "progression"
                ? "bg-red-500/15 text-red-400"
                : "bg-blue-500/15 text-blue-400")
          }
        >
          {evolution === "stable"
            ? "🟢 Stable"
            : evolution === "progression"
              ? "🔴 Progression"
              : "🔵 Régression"}
          {comparedPriorDate
            ? ` · vs examen du ${formatDicomDate(comparedPriorDate)}`
            : ""}
        </div>
      )}

      {/* --- Outils d'analyse avancés (repliés : « Analyser (IA) » couvre le
          cas courant ; ici les analyses spécialisées, à la demande) -------- */}
      {!isSigned && (
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="w-fit text-[11px] text-muted-foreground hover:text-foreground"
          title="Outils spécialisés : recherche de fractures, pré-analyse rapide d'une série, segmentation, compte rendu précis."
        >
          {showAdvanced ? "▾" : "▸"} Options avancées
        </button>
      )}
      {!isSigned && showAdvanced && (
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() =>
              runPreanalysis(antecedents, {
                seriesId: (findBoneSeries(seriesList) ?? { id: seriesId }).id,
                ...BONE_WINDOW,
              })
            }
            disabled={preanalyze.isPending || (gpuManaged && !gpuReady)}
            className="text-[11px] rounded bg-amber-500/15 text-amber-600 px-2 py-1 disabled:opacity-50"
            title="Analyse la série osseuse en fenêtre Bone (2000/500) — recherche de fracture"
          >
            Analyser les fractures
          </button>
          <button
            type="button"
            onClick={() => runPreanalysis()}
            disabled={
              preanalyze.isPending ||
              keyImages.length === 0 ||
              (gpuManaged && !gpuReady)
            }
            className="text-[11px] rounded bg-primary/15 text-primary px-2 py-1 disabled:opacity-50"
            title="Analyse la série affichée dans la fenêtre courante"
          >
            {preanalyze.isPending ? "Analyse en cours…" : "Pré-analyse IA"}
          </button>
          <select
            value={segTask}
            onChange={e => setSegTask(e.target.value as typeof segTask)}
            className="text-[11px] rounded bg-purple-500/10 text-purple-300 px-1 py-1 border border-purple-500/30"
            title="Région à segmenter (choisis tête/cou pour un scanner de face ou de crâne)"
          >
            <option value="total">Corps (CT)</option>
            <option value="total_mr">Corps (IRM)</option>
            <option value="head_glands_cavities">
              Tête : yeux/sinus/glandes
            </option>
            <option value="headneck_bones_vessels">
              Tête-cou : os/vaisseaux
            </option>
            <option value="brain_structures">Cerveau (ventricules)</option>
          </select>
          <button
            type="button"
            onClick={() =>
              segmentCt.mutate({
                studyId,
                seriesId: analyzedSeriesId ?? seriesId,
                highRes: highResSeg,
                task: segTask,
              })
            }
            disabled={segmentCt.isPending || (gpuManaged && !gpuReady)}
            className="text-[11px] rounded bg-purple-500/15 text-purple-400 px-2 py-1 disabled:opacity-50"
            title="Segmentation anatomique open-source (TotalSegmentator) — structures + volumes (CT). Aide non certifiée."
          >
            {segmentCt.isPending
              ? "Segmentation… (~1 min)"
              : "Segmentation IA (CT)"}
          </button>
          <button
            type="button"
            onClick={() =>
              runPreanalysis(antecedents, {
                includeSegmentation: true,
                highResSegmentation: highResSeg,
              })
            }
            disabled={preanalyze.isPending || (gpuManaged && !gpuReady)}
            className="text-[11px] rounded bg-emerald-500/15 text-emerald-400 px-2 py-1 disabled:opacity-50"
            title="Compte rendu vision ANCRÉ dans les volumes mesurés par la segmentation (CT) — plus précis, ~1-2 min."
          >
            {preanalyze.isPending
              ? "Analyse précise…"
              : "Compte rendu IA précis (CT)"}
          </button>
        </div>
      )}
      {!isSigned &&
        secondOpinion &&
        (secondOpinion.abnormal != null && !secondOpinion.agree ? (
          // DÉSACCORD entre les 2 modèles = signal d'incertitude le plus
          // important : on le rend SAILLANT (bandeau encadré) pour qu'il ne
          // passe pas inaperçu, contrairement à l'accord/non-concluant discrets.
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 px-2.5 py-2 text-[12px] font-medium text-amber-600 dark:text-amber-400"
          >
            <span aria-hidden className="mt-px text-base leading-none">
              ⚠
            </span>
            <span>
              Désaccord entre les 2 modèles IA sur la présence d'une anomalie —
              relire les images attentivement avant de conclure.
            </span>
          </div>
        ) : (
          <p
            className={`text-[11px] ${
              secondOpinion.abnormal == null
                ? "text-muted-foreground"
                : "text-green-500"
            }`}
          >
            {secondOpinion.abnormal == null
              ? "2e modèle : avis non concluant"
              : "✓ 2e modèle d'accord avec le 1er"}
          </p>
        ))}

      {/* --- IA CERTIFIÉE (dispositifs médicaux CE/FDA) -------------------- */}
      {!isSigned && (
        <div className="rounded-md border border-border/60 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium">
              IA certifiée (dispositif médical)
            </span>
            <span
              className={`text-[10px] ${
                certifiedConfigured ? "text-green-500" : "text-muted-foreground"
              }`}
            >
              {certifiedConfigured ? "● branchée" : "○ non branchée"}
            </span>
          </div>
          {certifiedConfigured ? (
            <button
              type="button"
              disabled={certifiedAnalysis.isPending}
              onClick={() =>
                certifiedAnalysis.mutate({
                  studyId,
                  seriesId: analyzedSeriesId ?? seriesId,
                })
              }
              className="text-[11px] rounded bg-emerald-500/15 text-emerald-400 px-2 py-1 disabled:opacity-50"
            >
              {certifiedAnalysis.isPending
                ? "Analyse certifiée…"
                : "Lancer l'analyse certifiée"}
            </button>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              Aucun moteur certifié branché. Le compte rendu IA ci-dessus est
              une aide NON certifiée, à valider et signer par le médecin.
              Moteurs intégrables :{" "}
              {(certifiedInventory.data ?? []).map(p => p.name).join(", ") ||
                "—"}
              .
            </p>
          )}
          {certifiedAnalysis.data?.available === false && (
            <p className="text-[10px] text-amber-500">
              Aucun moteur certifié disponible pour cette modalité (
              {certifiedAnalysis.data.modality}).
            </p>
          )}
          {certifiedAnalysis.data?.available === true && (
            <div className="text-[11px] space-y-1">
              <p className="font-medium text-emerald-400">
                {certifiedAnalysis.data.result.provider} —{" "}
                {certifiedAnalysis.data.result.regulatory}
              </p>
              {certifiedAnalysis.data.result.findings.length === 0 ? (
                <p className="text-muted-foreground">
                  Aucune anomalie signalée par le moteur certifié.
                </p>
              ) : (
                <ul className="list-disc pl-4 space-y-0.5">
                  {certifiedAnalysis.data.result.findings.map((f, i) => (
                    <li key={i}>
                      {f.category ? <b>[{f.category}] </b> : null}
                      {f.label}
                      {f.confidence != null
                        ? ` (${Math.round(f.confidence * 100)}%)`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[9px] text-muted-foreground italic">
                {certifiedAnalysis.data.result.disclaimer}
              </p>
            </div>
          )}
        </div>
      )}

      {/* --- Analyse exhaustive (toutes les coupes) ----------------------- */}
      {!isSigned && (
        <div className="flex items-center gap-2 flex-wrap">
          {/* L'analyse exhaustive est déclenchée par « Générer (IA) » ci-dessus ;
              on garde ici la progression et le bilan du balayage. */}
          {exhaustiveStatus.data?.status === "running" && (
            <span className="text-[11px] text-blue-400">
              {(exhaustiveStatus.data as { phase?: string }).phase ??
                "Balayage…"}{" "}
              {exhaustiveStatus.data.progress?.done ?? 0}/
              {exhaustiveStatus.data.progress?.total ?? "?"} coupes
              {(exhaustiveStatus.data.progress?.done ?? 0) === 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  — le rendu initial peut prendre 1–2 min sur une longue série
                </span>
              )}
            </span>
          )}
          {exhaustiveStatus.data?.status === "done" &&
            exhaustiveStatus.data.result && (
              <span className="text-[11px] text-green-500">
                ✓ {exhaustiveStatus.data.result.screenedSlices} coupes analysées
                · {exhaustiveStatus.data.result.flaggedSlices.length}{" "}
                suspecte(s)
                {exhaustiveStatus.data.result.flaggedSlices.length > 0
                  ? ` (n° ${exhaustiveStatus.data.result.flaggedSlices.slice(0, 10).join(", ")})`
                  : ""}
              </span>
            )}
          {exhaustiveStatus.data?.status === "error" && (
            <span className="text-[11px] text-destructive">
              Analyse exhaustive échouée
            </span>
          )}
        </div>
      )}

      {/* --- Résultat segmentation CT (TotalSegmentator) ------------------ */}
      {!isSigned && segmentCt.isError && (
        <p className="text-[10px] text-destructive">
          Segmentation indisponible (réveille l'IA ou réessaie).
        </p>
      )}
      {!isSigned && segmentCt.data && (
        <div className="mt-1 rounded border border-purple-500/30 p-2 space-y-1">
          <p className="text-[11px] font-medium text-purple-400">
            {segmentCt.data.count} structures détectées (TotalSegmentator,{" "}
            {segmentCt.data.durationS}s) — aide non certifiée, à valider.
          </p>
          <div className="max-h-40 overflow-auto text-[11px]">
            {segmentCt.data.structures.map(s => (
              <div
                key={s.name}
                className="flex justify-between border-b border-border/20 py-0.5"
              >
                <span className="text-muted-foreground">{s.name}</span>
                <span className="text-foreground font-mono">
                  {s.volumeMl} mL
                </span>
              </div>
            ))}
          </div>
          {segmentCt.data.overlays && segmentCt.data.overlays.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">
                Organes colorés sur l'image (coupes réparties) :
              </p>
              <div className="grid grid-cols-3 gap-1">
                {segmentCt.data.overlays.map(o => (
                  <a
                    key={o.sliceIndex}
                    href={`data:image/png;base64,${o.pngBase64}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`Coupe ${o.sliceIndex} — cliquer pour agrandir`}
                  >
                    <img
                      src={`data:image/png;base64,${o.pngBase64}`}
                      alt={`coupe ${o.sliceIndex}`}
                      className="w-full rounded border border-purple-500/30"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- Mode validation IA : verdict du médecin + fiabilité mesurée -- */}
      {(aiAssisted || aiEval.data?.verdict != null) && (
        <div className="mt-1 rounded border border-border/50 p-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Après ta lecture, la pré-analyse IA était :
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(
              [
                ["juste", "✅ Juste", "bg-green-500/15 text-green-500"],
                ["partielle", "⚠️ Partielle", "bg-amber-500/15 text-amber-600"],
                ["fausse", "❌ Fausse", "bg-red-500/15 text-red-400"],
              ] as const
            ).map(([v, label, cls]) => (
              <button
                key={v}
                type="button"
                disabled={recordEval.isPending}
                onClick={() => submitVerdict(v)}
                className={`text-[11px] rounded px-2 py-1 disabled:opacity-50 ${cls} ${
                  aiEval.data?.verdict === v
                    ? "ring-2 ring-offset-1 ring-current"
                    : ""
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={missedFinding}
              onChange={e => setMissedFinding(e.target.checked)}
            />
            L'IA a manqué une anomalie réelle
          </label>
          {aiEval.data?.verdict && (
            <p className="text-[10px] text-green-500">
              Verdict enregistré, merci.
            </p>
          )}
          {aiEvalStats.data && aiEvalStats.data.total > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Fiabilité mesurée :{" "}
              <span className="text-foreground font-medium">
                {Math.round(
                  ((aiEvalStats.data.juste + aiEvalStats.data.partielle * 0.5) /
                    aiEvalStats.data.total) *
                    100
                )}
                %
              </span>{" "}
              ({aiEvalStats.data.juste} justes · {aiEvalStats.data.partielle}{" "}
              partielles · {aiEvalStats.data.fausse} fausses sur{" "}
              {aiEvalStats.data.total} évaluées
              {aiEvalStats.data.missed > 0
                ? ` · ⚠️ ${aiEvalStats.data.missed} anomalie(s) ratée(s)`
                : ""}
              )
            </p>
          )}
        </div>
      )}

      {/* --- Vue signée : addenda + PDF ----------------------------------- */}
      {isSigned && report && (
        <div className="space-y-2">
          <div className="text-xs text-green-500">
            Signé
            {report.signedAt
              ? ` le ${new Date(report.signedAt).toLocaleString("fr-CH")}`
              : ""}
            .
          </div>
          {(reportQuery.data?.addenda ?? []).map((a: any) => (
            <div key={a.id} className="text-xs border-l-2 border-border pl-2">
              <div className="text-muted-foreground">
                Addendum — {new Date(a.createdAt).toLocaleString("fr-CH")}
              </div>
              <div>{a.text}</div>
            </div>
          ))}
          <textarea
            className={field}
            rows={2}
            placeholder="Ajouter un addendum…"
            value={addendumText}
            onChange={e => setAddendumText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!addendumText.trim() || addAddendum.isPending}
              onClick={async () => {
                await addAddendum.mutateAsync({
                  reportId: report.id,
                  text: addendumText,
                });
                setAddendumText("");
                reportQuery.refetch();
              }}
            >
              Ajouter l'addendum
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const r = await trpcUtils.reports.pdfUrl.fetch({
                  reportId: report.id,
                });
                if (r?.url) window.open(r.url, "_blank");
              }}
            >
              Télécharger PDF
            </Button>
          </div>
        </div>
      )}

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

      <textarea
        className={field}
        rows={2}
        placeholder="Message (optionnel)"
        value={message}
        onChange={e => setMessage(e.target.value)}
      />

      {isSigned ? (
        <button
          onClick={submit}
          disabled={send.isPending || !to}
          className="w-full rounded bg-primary text-primary-foreground py-2 text-sm font-medium disabled:opacity-50"
        >
          {send.isPending ? "Génération et envoi…" : "Envoyer au confrère"}
        </button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Signez le compte-rendu pour pouvoir l'envoyer.
        </p>
      )}
      {send.isError && (
        <p className="text-xs text-destructive">{send.error.message}</p>
      )}
      {send.isSuccess && (
        <p className="text-xs text-green-500">Compte rendu envoyé.</p>
      )}
    </div>
  );
}
