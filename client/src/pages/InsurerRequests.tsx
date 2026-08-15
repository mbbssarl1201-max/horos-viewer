// client/src/pages/InsurerRequests.tsx
//
// Page « Demandes assureurs » (Agent SUVA, Task 9) : file d'attente des
// demandes d'imagerie reçues par mail (Task 8), validation 1 clic. Accès
// clinique uniquement (insurer.* = medicalProcedure) : la liste et le détail
// exposent des PHI (identité patient, examens, adresse de réponse).
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  RefreshCw,
  Mail,
  User,
  FileText,
  Link2,
  CheckCircle2,
  XCircle,
  ShieldOff,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

type Statut =
  | "recue"
  | "extraite"
  | "identifiee"
  | "prete"
  | "a_valider"
  | "envoyee"
  | "rejetee"
  | "erreur";

// Formate une date DICOM (YYYYMMDD) en JJ.MM.AAAA ; renvoie la valeur brute
// si elle n'est pas au format attendu.
function formatDicomDate(d: string | null | undefined): string {
  if (!d || !/^\d{8}$/.test(d)) return d || "—";
  return `${d.slice(6, 8)}.${d.slice(4, 6)}.${d.slice(0, 4)}`;
}

const STATUT_LABEL: Record<Statut, string> = {
  recue: "Reçue",
  extraite: "Extraite",
  identifiee: "Identifiée",
  prete: "Prête",
  a_valider: "À valider",
  envoyee: "Envoyée",
  rejetee: "Rejetée",
  erreur: "Erreur",
};

// Palette cohérente avec MODALITY_COLOR (CockpitMediView.tsx) : fond/texte
// tramés + bordure assortie, lisible en thème sombre.
const STATUT_COLOR: Record<Statut, string> = {
  recue: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  extraite: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  identifiee: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
  prete: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  a_valider: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  envoyee: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rejetee: "bg-red-500/20 text-red-300 border-red-500/30",
  erreur: "bg-red-500/20 text-red-300 border-red-500/30",
};

function StatutBadge({ statut }: { statut: string }) {
  const s = statut as Statut;
  return (
    <Badge
      variant="outline"
      className={`${STATUT_COLOR[s] ?? "bg-slate-500/20 text-slate-300 border-slate-500/30"} font-normal`}
    >
      {STATUT_LABEL[s] ?? statut}
    </Badge>
  );
}

// Verdict « simple » : la seule info que le gérant veut voir d'un coup d'œil.
const VERDICT_UI: Record<
  string,
  { label: string; cls: string; banner: string; bannerCls: string }
> = {
  disponible: {
    label: "✅ Résultat dispo",
    cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    banner:
      "✅ ON A LE RÉSULTAT — patient et examens trouvés, images complètes. Vérifiez le nom ci-dessous puis « Valider et envoyer ».",
    bannerCls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  preparation: {
    label: "🕓 En préparation",
    cls: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    banner:
      "🕓 RÉSULTAT TROUVÉ — les images sont en cours de récupération depuis le PACS du cabinet. Revenez d'ici quelques minutes (le Mac passerelle doit être au cabinet).",
    bannerCls: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
  },
  introuvable: {
    label: "❌ Pas chez nous",
    cls: "bg-red-500/20 text-red-300 border-red-500/30",
    banner:
      "❌ PAS DE RÉSULTAT CORRESPONDANT — ce patient ou cet examen n'est pas dans notre PACS (fait ailleurs, ou date différente). → « Rejeter », ou répondre à la main.",
    bannerCls: "border-red-500/40 bg-red-500/10 text-red-200",
  },
  envoyee: {
    label: "📤 Envoyée",
    cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    banner: "📤 Réponse déjà envoyée à la SUVA.",
    bannerCls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  rejetee: {
    label: "🚫 Rejetée",
    cls: "bg-slate-500/20 text-slate-300 border-slate-500/30",
    banner: "🚫 Demande rejetée (aucun envoi).",
    bannerCls: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  },
  en_cours: {
    label: "… Lecture",
    cls: "bg-slate-500/20 text-slate-300 border-slate-500/30",
    banner: "… Lecture du courrier en cours (moins de 2 minutes).",
    bannerCls: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  },
};

function VerdictBadge({
  verdict,
  statut,
}: {
  verdict?: string;
  statut: string;
}) {
  const v = verdict ? VERDICT_UI[verdict] : undefined;
  if (!v) return <StatutBadge statut={statut} />;
  return (
    <Badge
      variant="outline"
      className={`${v.cls} font-normal whitespace-nowrap`}
    >
      {v.label}
    </Badge>
  );
}

function formatDate(v: unknown): string {
  if (!v) return "-";
  const t = new Date(v as string | number | Date);
  if (Number.isNaN(t.getTime())) return "-";
  return t.toLocaleString("fr-CH");
}

export default function InsurerRequests() {
  const { user, isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const [filterStatut, setFilterStatut] = useState<Statut | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rejectMotif, setRejectMotif] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  // Examens cochés pour l'envoi (par défaut : tous ceux qui ont des images).
  const [etudesCochees, setEtudesCochees] = useState<Set<number>>(new Set());

  const hasMedicalAccess =
    user?.role === "admin" ||
    user?.role === "radiologist" ||
    user?.role === "technician";

  const list = trpc.insurer.list.useQuery(
    { statut: filterStatut === "all" ? undefined : filterStatut },
    { enabled: isAuthenticated && hasMedicalAccess }
  );
  const detail = trpc.insurer.detail.useQuery(
    { id: selectedId as number },
    { enabled: isAuthenticated && hasMedicalAccess && selectedId != null }
  );

  const utils = trpc.useUtils();
  const invalidateAll = () => {
    utils.insurer.list.invalidate();
    if (selectedId != null) utils.insurer.detail.invalidate({ id: selectedId });
  };

  const approve = trpc.insurer.approve.useMutation({
    onSuccess: result => {
      if (result.success) {
        toast.success("Demande validée et envoyée à l'assureur.");
      } else {
        toast.error(`Échec de l'envoi : ${result.error}`);
      }
      invalidateAll();
    },
    onError: err => toast.error(err.message),
  });

  const reject = trpc.insurer.reject.useMutation({
    onSuccess: () => {
      toast.success("Demande rejetée.");
      setShowRejectForm(false);
      setRejectMotif("");
      invalidateAll();
    },
    onError: err => toast.error(err.message),
  });

  const revokeToken = trpc.insurer.revokeToken.useMutation({
    onSuccess: () => {
      toast.success("Lien(s) de téléchargement révoqué(s).");
      invalidateAll();
    },
    onError: err => toast.error(err.message),
  });

  const reprocess = trpc.insurer.reprocess.useMutation({
    onSuccess: () => {
      toast.success("Demande re-traitée (patient et études réévalués).");
      invalidateAll();
    },
    onError: err => toast.error(err.message),
  });

  if (!loading && !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">
          Session requise.{" "}
          <button className="underline" onClick={() => navigate("/login")}>
            Se connecter
          </button>
        </p>
      </div>
    );
  }

  if (!loading && isAuthenticated && !hasMedicalAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">
          Accès réservé au personnel clinique (admin / radiologue / technicien).
        </p>
      </div>
    );
  }

  const items = list.data?.items ?? [];
  const request = detail.data?.request;
  const tokens = detail.data?.tokens ?? [];
  const mailPreview = detail.data?.mailPreview;
  const etudes = detail.data?.etudes ?? [];
  const pieces = detail.data?.pieces ?? [];
  const crCuramed = detail.data?.crCuramed ?? [];
  // Rapport(s) curaMED cochés (par défaut : le mieux classé).
  const [crCoches, setCrCoches] = useState<Set<string>>(new Set());

  // À chaque nouvelle demande affichée : pré-cocher tous les examens matchés
  // qui ont des images (le gérant décoche ceux qui ne correspondent pas).
  useEffect(() => {
    setEtudesCochees(
      new Set(
        (detail.data?.etudes ?? [])
          .filter((e: any) => e.numberOfInstances > 0)
          .map((e: any) => e.studyId)
      )
    );
    const cr = detail.data?.crCuramed ?? [];
    setCrCoches(new Set(cr.length ? [cr[0].reference] : []));
  }, [detail.data?.request?.id, detail.data?.etudes?.length]);
  const extraction = (request?.extraction ?? null) as {
    patient?: {
      nom: string | null;
      prenom: string | null;
      ddn: string | null;
      tel: string | null;
    };
    exams?: {
      modalite: string | null;
      dateDemandee: string | null;
      description: string | null;
    }[];
    refSinistre?: string | null;
    adresseReponse?: string | null;
    confiance?: number;
  } | null;

  const STATUTS_VALIDABLES = ["a_valider", "prete", "erreur"];
  const STATUTS_REJETABLES = [
    "recue",
    "extraite",
    "identifiee",
    "a_valider",
    "prete",
    "erreur",
  ];
  const peutValider = request
    ? STATUTS_VALIDABLES.includes(request.statut)
    : false;
  const peutRejeter = request
    ? STATUTS_REJETABLES.includes(request.statut)
    : false;
  const tokensActifs = tokens.filter(t => !t.revoqueLe);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Barre supérieure */}
      <div className="h-12 border-b border-border bg-card flex items-center px-3 gap-2 shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Mail className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-semibold">Demandes assureurs</h1>
        <div className="flex-1" />
        <Select
          value={filterStatut}
          onValueChange={v => setFilterStatut(v as Statut | "all")}
        >
          <SelectTrigger size="sm" className="w-44 text-xs">
            <SelectValue placeholder="Tous les statuts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            {(Object.keys(STATUT_LABEL) as Statut[]).map(s => (
              <SelectItem key={s} value={s}>
                {STATUT_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => list.refetch()}
          disabled={list.isFetching}
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${list.isFetching ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden min-w-0">
        {/* Liste */}
        <div className="w-80 shrink-0 border-r border-border flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 min-h-0">
            {list.isLoading ? (
              <div className="p-4 text-xs text-muted-foreground">
                Chargement…
              </div>
            ) : list.error ? (
              <div className="p-4 text-xs text-destructive">
                {list.error.message}
              </div>
            ) : items.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">
                Aucune demande.
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {items.map((it: any) => (
                  <button
                    key={it.id}
                    onClick={() => {
                      setSelectedId(it.id);
                      setShowRejectForm(false);
                      setRejectMotif("");
                    }}
                    className={`w-full text-left p-3 hover:bg-accent/50 transition-colors ${
                      selectedId === it.id
                        ? "bg-primary/10 ring-1 ring-primary/30"
                        : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium truncate">
                        {it.patientLabel || it.sujet || it.expediteur}
                      </span>
                      <VerdictBadge verdict={it.verdict} statut={it.statut} />
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {it.patientLabel
                        ? it.expediteur
                        : it.sujet || "(sans objet)"}
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 mt-1">
                      {formatDate(it.recuLe)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Détail */}
        <div className="flex-1 overflow-hidden">
          {selectedId == null ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Sélectionnez une demande dans la liste.
            </div>
          ) : detail.isLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Chargement…
            </div>
          ) : detail.error ? (
            <div className="h-full flex items-center justify-center text-sm text-destructive">
              {detail.error.message}
            </div>
          ) : !request ? null : (
            <ScrollArea className="h-full">
              <div className="p-4 space-y-4 max-w-3xl">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold">
                      Demande #{request.id}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      De {request.expediteur} — reçue le{" "}
                      {formatDate(request.recuLe)}
                    </p>
                  </div>
                  <VerdictBadge
                    verdict={detail.data?.verdict}
                    statut={request.statut}
                  />
                </div>

                {/* LA réponse que le gérant attend, en un coup d'œil. */}
                {detail.data?.verdict && VERDICT_UI[detail.data.verdict] && (
                  <div
                    className={`rounded border p-3 text-sm font-medium ${VERDICT_UI[detail.data.verdict].bannerCls}`}
                  >
                    {VERDICT_UI[detail.data.verdict].banner}
                  </div>
                )}

                {request.erreur && (
                  <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {request.erreur}
                  </div>
                )}

                {request.motifValidation && (
                  <details className="text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      Détails techniques
                    </summary>
                    <div className="mt-1 rounded border border-border p-2">
                      {request.motifValidation}
                    </div>
                  </details>
                )}

                {/* Document reçu de la SUVA : la feuille scannée telle quelle,
                    pour confirmer l'extraction d'un coup d'œil. */}
                {pieces.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      Document reçu (feuille SUVA)
                    </h3>
                    <div className="rounded border border-border p-2 space-y-2">
                      {pieces
                        .filter((p: any) => p.ext !== "pdf")
                        .map((p: any) => (
                          <img
                            key={p.idx}
                            src={`/api/insurer/piece/${request.id}/${p.idx}`}
                            alt={`Page ${p.idx + 1} du document reçu`}
                            className="w-full rounded border border-border bg-white"
                            loading="lazy"
                          />
                        ))}
                      {pieces
                        .filter((p: any) => p.ext === "pdf")
                        .map((p: any) => (
                          <a
                            key={p.idx}
                            href={`/api/insurer/piece/${request.id}/${p.idx}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                          >
                            📄 Ouvrir le PDF original
                          </a>
                        ))}
                    </div>
                  </section>
                )}

                {/* Extraction */}
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    Extraction lue
                  </h3>
                  {!extraction ? (
                    <p className="text-xs text-muted-foreground">
                      Pas encore extraite.
                    </p>
                  ) : (
                    <div className="rounded border border-border p-3 space-y-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">
                          Identité :{" "}
                        </span>
                        {extraction.patient?.nom || extraction.patient?.prenom
                          ? `${extraction.patient?.prenom ?? ""} ${extraction.patient?.nom ?? ""}`.trim()
                          : "-"}
                        {extraction.patient?.ddn
                          ? ` (né(e) le ${extraction.patient.ddn})`
                          : ""}
                        {extraction.patient?.tel
                          ? ` — tél. ${extraction.patient.tel}`
                          : ""}
                      </div>
                      {extraction.refSinistre && (
                        <div>
                          <span className="text-muted-foreground">
                            Réf. sinistre :{" "}
                          </span>
                          {extraction.refSinistre}
                        </div>
                      )}
                      {extraction.adresseReponse && (
                        <div>
                          <span className="text-muted-foreground">
                            Adresse de réponse :{" "}
                          </span>
                          {extraction.adresseReponse}
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">
                          Examens demandés :
                        </span>
                        <ul className="mt-1 space-y-0.5 list-disc list-inside">
                          {(extraction.exams ?? []).length === 0 ? (
                            <li className="text-muted-foreground/70">
                              Aucun examen lu.
                            </li>
                          ) : (
                            (extraction.exams ?? []).map((ex, i) => (
                              <li key={i}>
                                {ex.modalite || "?"} —{" "}
                                {ex.description || "(sans description)"}
                                {ex.dateDemandee ? ` (${ex.dateDemandee})` : ""}
                              </li>
                            ))
                          )}
                        </ul>
                      </div>
                      {typeof extraction.confiance === "number" && (
                        <div className="text-muted-foreground">
                          Confiance du modèle :{" "}
                          {Math.round(extraction.confiance * 100)}%
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* Patient identifié / études */}
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />
                    Patient identifié &amp; études
                  </h3>
                  <div className="rounded border border-border p-3 space-y-2 text-xs">
                    {request.patientId == null ? (
                      <div className="text-muted-foreground">
                        Patient non identifié dans MediView.
                      </div>
                    ) : etudes.length === 0 ? (
                      <div className="text-muted-foreground">
                        Dossier #{request.patientId} identifié, mais aucune
                        étude correspondante trouvée.
                      </div>
                    ) : (
                      <>
                        {/* Identité du DOSSIER retrouvé — à croiser avec la
                            feuille SUVA (section « Extraction lue » ci-dessus)
                            pour confirmer que c'est le bon patient. */}
                        <div className="rounded bg-muted/40 px-2 py-1.5">
                          <span className="text-muted-foreground">
                            Dossier retrouvé :{" "}
                          </span>
                          <span className="font-medium">
                            {etudes[0].patientName || "—"}
                          </span>
                          {etudes[0].birthDate ? (
                            <span className="text-muted-foreground">
                              {" "}
                              — né(e) le {etudes[0].birthDate}
                            </span>
                          ) : null}
                          <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
                            ⚠️ Vérifiez que ce nom et cette date correspondent à
                            la feuille SUVA avant d'envoyer.
                          </div>
                        </div>
                        {etudes.map(e => (
                          <div
                            key={e.studyId}
                            className="flex items-center justify-between gap-2 border-t border-border pt-1.5"
                          >
                            <label className="flex items-center gap-2 cursor-pointer">
                              {/* Cocher = inclure dans l'envoi à l'assureur.
                                  Ne jamais envoyer plus que demandé. */}
                              <input
                                type="checkbox"
                                className="accent-primary"
                                disabled={e.numberOfInstances === 0}
                                checked={etudesCochees.has(e.studyId)}
                                onChange={ev => {
                                  setEtudesCochees(prev => {
                                    const n = new Set(prev);
                                    if (ev.target.checked) n.add(e.studyId);
                                    else n.delete(e.studyId);
                                    return n;
                                  });
                                }}
                              />
                              <span>
                                {e.modality || "?"} —{" "}
                                {formatDicomDate(e.studyDate)}
                                {e.studyDescription ? (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    — {e.studyDescription}
                                  </span>
                                ) : null}{" "}
                                —{" "}
                                {e.numberOfInstances > 0 ? (
                                  `${e.numberOfInstances} image(s)`
                                ) : (
                                  <span className="text-amber-600 dark:text-amber-500">
                                    images en cours de rapatriement
                                  </span>
                                )}
                              </span>
                            </label>
                            <a
                              href={`/viewer/${e.studyId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-muted"
                            >
                              Ouvrir
                            </a>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </section>

                {/* Rapport(s) écrits trouvés dans le stock curaMED : cochés =
                    joints au mail SUVA en PDF à la validation. */}
                {crCuramed.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      Rapport écrit (curaMED)
                    </h3>
                    <div className="rounded border border-border p-3 space-y-1.5 text-xs">
                      {crCuramed.map((c: any) => (
                        <label
                          key={c.reference}
                          className="flex items-center gap-2 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={crCoches.has(c.reference)}
                            onChange={ev => {
                              setCrCoches(prev => {
                                const n = new Set(prev);
                                if (ev.target.checked) n.add(c.reference);
                                else n.delete(c.reference);
                                return n;
                              });
                            }}
                          />
                          <span>
                            📄 {c.titre}
                            {c.date ? (
                              <span className="text-muted-foreground">
                                {" "}
                                — {formatDicomDate(c.date)}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                      <div className="text-[11px] text-muted-foreground">
                        Coché = joint au mail en PDF avec les images.
                      </div>
                    </div>
                  </section>
                )}

                {/* Aperçu du mail */}
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    Aperçu du mail de réponse
                  </h3>
                  {mailPreview ? (
                    <div className="rounded border border-border overflow-hidden">
                      <div className="px-3 py-1.5 text-xs bg-muted/40 border-b border-border">
                        <span className="text-muted-foreground">Objet : </span>
                        {mailPreview.subject}
                      </div>
                      {/* Rendu HTML serveur (échappé côté serveur) dans un
                          iframe sandboxée : aucun script, aucune navigation,
                          aucun accès au parent — cf. brief Task 9. */}
                      <iframe
                        title="Aperçu du mail"
                        sandbox=""
                        srcDoc={mailPreview.html}
                        className="w-full h-64 bg-white"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Aperçu indisponible.
                    </p>
                  )}
                </section>

                {/* Jetons de téléchargement */}
                {tokens.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5" />
                      Liens de téléchargement
                    </h3>
                    <div className="rounded border border-border p-3 space-y-1 text-xs">
                      {tokens.map(t => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="text-muted-foreground">
                            Jeton #{t.id} — expire le {formatDate(t.expireLe)} —{" "}
                            {t.telechargements} téléchargement
                            {t.telechargements > 1 ? "s" : ""}
                            {t.revoqueLe ? " — révoqué" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <Separator />

                {/* Actions */}
                <section className="space-y-2 pb-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={
                        !peutValider ||
                        approve.isPending ||
                        (etudes.length > 0 && etudesCochees.size === 0)
                      }
                      onClick={() => {
                        const n = etudesCochees.size;
                        if (
                          window.confirm(
                            `Envoyer ${n} examen(s) coché(s) (colis DICOM + CR) à la SUVA ?`
                          )
                        ) {
                          approve.mutate({
                            id: request.id,
                            ...(etudes.length > 0
                              ? { studyIds: Array.from(etudesCochees) }
                              : {}),
                            ...(crCoches.size > 0
                              ? { crCuramedRefs: Array.from(crCoches) }
                              : {}),
                          });
                        }
                      }}
                      className="gap-1.5"
                    >
                      {approve.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      Valider et envoyer
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!peutRejeter || reject.isPending}
                      onClick={() => setShowRejectForm(o => !o)}
                      className="gap-1.5"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Rejeter
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reprocess.isPending}
                      onClick={() => reprocess.mutate({ id: request.id })}
                      className="gap-1.5"
                      title="Réévalue le patient et les études (ex : après import de l'historique du PACS)"
                    >
                      {reprocess.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      Re-traiter
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        tokensActifs.length === 0 || revokeToken.isPending
                      }
                      onClick={() => {
                        if (
                          window.confirm(
                            "Révoquer tous les liens de téléchargement de cette demande ?"
                          )
                        ) {
                          revokeToken.mutate({ requestId: request.id });
                        }
                      }}
                      className="gap-1.5"
                    >
                      {revokeToken.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ShieldOff className="w-3.5 h-3.5" />
                      )}
                      Révoquer le lien
                    </Button>
                  </div>

                  {showRejectForm && (
                    <div className="rounded border border-border p-3 space-y-2">
                      <label className="text-xs text-muted-foreground">
                        Motif du rejet (requis)
                      </label>
                      <Textarea
                        value={rejectMotif}
                        onChange={e => setRejectMotif(e.target.value)}
                        placeholder="ex. examens hors périmètre, demande incomplète…"
                        className="text-xs"
                        rows={3}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setShowRejectForm(false);
                            setRejectMotif("");
                          }}
                        >
                          Annuler
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!rejectMotif.trim() || reject.isPending}
                          onClick={() =>
                            reject.mutate({
                              id: request.id,
                              motif: rejectMotif.trim(),
                            })
                          }
                        >
                          {reject.isPending ? "Rejet…" : "Confirmer le rejet"}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
