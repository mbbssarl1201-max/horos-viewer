import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { findBoneSeries, BONE_WINDOW } from "@/lib/boneSeries";

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
  const gpuBusy = gpuState === "waking" || gpuState === "starting";

  // --- Mode validation IA : verdict du médecin + stats d'accord -------------
  const aiEval = trpc.ai.evaluation.useQuery({ studyId });
  const aiEvalStats = trpc.ai.evaluationStats.useQuery();
  const recordEval = trpc.ai.recordEvaluation.useMutation();
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

  const runPreanalysis = async (
    antecedentsArg = antecedents,
    override?: {
      seriesId?: number;
      windowCenter?: number;
      windowWidth?: number;
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
    });
    setAnalyzedSeriesId(sid);
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
      !preanalyze.isPending
    ) {
      autoRan.current = true;
      const auto = history.data?.antecedents || "";
      void runPreanalysis(auto).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, history.isFetched, reportQuery.isFetched]);

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
        disabled={isSigned}
      />

      {/* --- Éditeur 4 sections ------------------------------------------- */}
      {SECTION_KEYS.map(k => (
        <div key={k} className="space-y-1">
          <label className="text-xs font-medium capitalize">{k}</label>
          <textarea
            className={field}
            rows={k === "resultats" ? 5 : 2}
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
                  ? ` — coupe n° ${aiKeySlice} (ajoutée aux images clés)`
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

      {/* --- Actions brouillon -------------------------------------------- */}
      {!isSigned && (
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={aiGenerate.isPending || (gpuManaged && !gpuReady)}
            onClick={async () => {
              const r = await aiGenerate.mutateAsync({
                studyId,
                seriesId: analyzedSeriesId ?? seriesId,
                indication: sections.indication || undefined,
                antecedents: antecedents || undefined,
                keyImages: keyImages.map(k => ({
                  pngBase64: k.pngBase64,
                  sliceIndex: k.sliceIndex,
                })),
                priorStudyId: comparePriorStudyId ?? undefined,
                priorSeriesId: comparePriorSeriesId ?? undefined,
              });
              // Ne pré-remplit QUE les champs vides.
              setSections(s => ({
                indication: s.indication || r.sections.indication,
                technique: s.technique || r.sections.technique,
                resultats: s.resultats || r.sections.resultats,
                conclusion: s.conclusion || r.sections.conclusion,
              }));
              setEvolution(r.evolution ?? null);
              setComparedPriorDate(r.comparedPriorDate ?? null);
              if (
                r.keyImage &&
                onAddKeyImage &&
                !keyImages.some(k => k.sliceIndex === r.keyImage!.sliceIndex)
              ) {
                onAddKeyImage({
                  pngBase64: r.keyImage.pngBase64,
                  sliceIndex: r.keyImage.sliceIndex,
                });
              }
            }}
          >
            {aiGenerate.isPending ? "Analyse…" : "Générer (IA)"}
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

      {/* --- Boutons pré-analyse enrichie (anomalie / fractures) ---------- */}
      {!isSigned && (
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
