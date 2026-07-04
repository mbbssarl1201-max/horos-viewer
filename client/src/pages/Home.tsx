import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import DicomImport from "@/components/DicomImport";
import NotificationsPanel from "@/components/NotificationsPanel";
import ExportPanel from "@/components/ExportPanel";
import AnonymizeDialog from "@/components/AnonymizeDialog";
import QueryPACS from "@/components/QueryPACS";
import WorklistDialog from "@/components/WorklistDialog";
import { sortStudies, nextSort, type SortKey } from "@/lib/homeSort";
import ShareStudyDialog from "@/components/ShareStudyDialog";
import { PendingSignatureList } from "@/components/PendingSignatureList";
import { HermesFinder } from "@/components/HermesFinder";
import { AgentCrSettings } from "@/components/AgentCrSettings";
import { AgentsDashboard } from "@/components/AgentsDashboard";
import { ReferentDirectory } from "@/components/ReferentDirectory";
import { useLocation } from "wouter";
import {
  Database,
  Star,
  Clock,
  FolderOpen,
  Upload,
  Download,
  Mail,
  Search,
  Shield,
  Cloud,
  Eye,
  Layers,
  FileText,
  LogIn,
  User,
  LogOut,
  Activity,
  MonitorUp,
  Trash2,
  Film,
  Send,
  Disc,
  Info,
  Monitor,
  PenTool,
  Timer,
  MessageSquare,
  Lock,
  Server,
  Plus,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ClipboardList,
  LayoutDashboard,
} from "lucide-react";
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { matchAllFields } from "@/lib/studySearch";

// Lazy : le panneau Eva/Cockpit n'est chargé qu'à l'ouverture (cockpitOpen) —
// évite d'embarquer son poids dans le chunk de la worklist (cf. App.tsx).
const CockpitMediView = lazy(() => import("@/pages/CockpitMediView"));
import { matchesTodayModality } from "@/lib/quickAlbums";
import { toast } from "sonner";

// All DICOM modalities as seen in Horos
const ALL_MODALITIES = [
  { key: "CR", label: "CR", description: "Computed Radiography" },
  { key: "SC", label: "SC", description: "Secondary Capture" },
  { key: "CT", label: "CT", description: "Computed Tomography" },
  { key: "MR", label: "MR", description: "Magnetic Resonance" },
  { key: "PT", label: "PT", description: "Positron Emission Tomography" },
  { key: "NM", label: "NM", description: "Nuclear Medicine" },
  { key: "US", label: "US", description: "Ultrasound" },
  { key: "XA", label: "XA", description: "X-Ray Angiography" },
  { key: "MG", label: "MG", description: "Mammography" },
  { key: "DR", label: "DR", description: "Digital Radiography" },
  { key: "RG", label: "RG", description: "Radiographic Imaging" },
  { key: "DX", label: "DX", description: "Digital X-Ray" },
  { key: "AU", label: "AU", description: "Audio" },
  { key: "OT", label: "OT", description: "Other" },
  { key: "RF", label: "RF", description: "Radio Fluoroscopy" },
  { key: "XC", label: "XC", description: "External-camera Photography" },
  { key: "ES", label: "ES", description: "Endoscopy" },
  { key: "VL", label: "VL", description: "Video Light" },
  { key: "SR", label: "SR", description: "Structured Report" },
];

// En-tête de colonne triable (Story 5.1) : bouton + indicateur de sens.
function SortHeader({
  label,
  col,
  className,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  className?: string;
  sortKey: SortKey | null;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      aria-sort={
        active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      title={`Trier par ${label}`}
      className={`${className ?? ""} px-1 flex items-center gap-0.5 text-left hover:text-foreground transition-colors ${
        active ? "text-foreground" : ""
      }`}
    >
      <span className="truncate">{label}</span>
      {active ? (
        sortDir === "asc" ? (
          <ChevronUp className="w-2.5 h-2.5 shrink-0" />
        ) : (
          <ChevronDown className="w-2.5 h-2.5 shrink-0" />
        )
      ) : (
        <ChevronsUpDown className="w-2.5 h-2.5 shrink-0 opacity-30" />
      )}
    </button>
  );
}

// Smart Albums like Horos
const SMART_ALBUMS = [
  { key: "database", label: "Database", icon: Database },
  { key: "comments", label: "Cases with comments", icon: MessageSquare },
  { key: "interesting", label: "Interesting Cases", icon: Star },
  { key: "recent_hour", label: "Just Acquired (today)", icon: Clock },
  { key: "added_hour", label: "Just Added (last hour)", icon: Plus },
  { key: "opened", label: "Just Opened", icon: FolderOpen },
];

// Suivi local des études ouvertes (« Just Opened ») — pas de PHI, juste des ids.
const OPENED_STUDIES_KEY = "mediview:openedStudies";
function readOpenedIds(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(OPENED_STUDIES_KEY) || "[]");
    return Array.isArray(v) ? v.filter(n => typeof n === "number") : [];
  } catch {
    return [];
  }
}
function recordOpenedId(id: number): number[] {
  const next = [id, ...readOpenedIds().filter(x => x !== id)].slice(0, 50);
  try {
    localStorage.setItem(OPENED_STUDIES_KEY, JSON.stringify(next));
  } catch {
    /* quota / mode privé : best-effort */
  }
  return next;
}

// Parse une date d'étude (DICOM YYYYMMDD ou ISO) ou un timestamp → ms, ou null.
function formatStudyDate(v: unknown): string {
  if (v == null) return "-";
  const s = String(v).trim();
  // Format DICOM YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
  }
  // ISO ou autre format reconnaissable
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    return new Date(t).toLocaleDateString("fr-CH");
  }
  return s || "-";
}

function parseStudyMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4),
      m = +s.slice(4, 6) - 1,
      d = +s.slice(6, 8);
    return new Date(y, m, d).getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Prédicat de smart album évalué côté client (sans DB). « last hour » utilise
// createdAt (timestamp réel) ; « today » utilise studyDate (souvent date seule).
function albumMatches(study: any, key: string, openedIds: number[]): boolean {
  const now = Date.now();
  switch (key) {
    case "database":
      return true;
    case "comments":
      return !!(study?.comments && String(study.comments).trim());
    case "interesting":
      return study?.priority === "stat" || study?.priority === "urgent";
    case "recent_hour": {
      const ms = parseStudyMs(study?.studyDate);
      return ms != null && now - ms < 24 * 3600 * 1000;
    }
    case "added_hour": {
      const ms = parseStudyMs(study?.createdAt);
      return ms != null && now - ms < 3600 * 1000;
    }
    case "opened":
      return openedIds.includes(study?.id);
    default:
      // Albums « Today <modalité> » façon Horos : clé « today:CT », « today:MR »…
      if (key.startsWith("today:")) {
        return matchesTodayModality(
          key.slice("today:".length),
          study,
          parseStudyMs(study?.studyDate),
          now
        );
      }
      return true;
  }
}

// Time interval filter options
const TIME_FILTERS = [
  { key: "none", label: "None" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_week", label: "Last Week" },
  { key: "last_month", label: "Last Month" },
  { key: "last_year", label: "Last Year" },
];

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [, navigate] = useLocation();
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedAlbum, setSelectedAlbum] = useState("database");
  const [selectedModality, setSelectedModality] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState("none");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showAnonymizeDialog, setShowAnonymizeDialog] = useState(false);
  const [showQueryPACS, setShowQueryPACS] = useState(false);
  const [showWorklist, setShowWorklist] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedStudyId, setSelectedStudyId] = useState<number | null>(null);
  const [showMetaData, setShowMetaData] = useState(false);
  // Recherche multi-champs (Search ⌘F) — filtrage client de la liste d'études.
  const [searchQuery, setSearchQuery] = useState("");
  // Ids des études récemment ouvertes (smart album « Just Opened »).
  const [openedIds, setOpenedIds] = useState<number[]>(() => readOpenedIds());

  const { data: studiesData, isLoading: studiesLoading } =
    trpc.studies.list.useQuery(
      {
        modality: selectedModality || undefined,
        timeFilter: timeFilter !== "none" ? timeFilter : undefined,
      },
      { enabled: isAuthenticated }
    );
  const utils = trpc.useUtils();
  const { data: pacsServersList } = trpc.pacsServers.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const createPacsServer = trpc.pacsServers.create.useMutation({
    onSuccess: () => {
      toast.success("PACS server added");
      utils.pacsServers.list.invalidate();
    },
  });
  const deletePacsServer = trpc.pacsServers.delete.useMutation({
    onSuccess: () => {
      toast.success("PACS server removed");
      utils.pacsServers.list.invalidate();
    },
  });
  const deleteStudy = trpc.studies.delete.useMutation({
    onSuccess: () => {
      toast.success("Study deleted");
      utils.studies.list.invalidate();
      setSelectedStudyId(null);
    },
    onError: err => toast.error(err.message),
  });
  const [showAddServer, setShowAddServer] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [sendTargetAet, setSendTargetAet] = useState<string>("");
  const [cockpitOpen, setCockpitOpen] = useState(false);

  // Clinical roles (admin/radiologist) may change RIS workflow state.
  const canEditWorkflow =
    user?.role === "admin" || user?.role === "radiologist";

  const { data: modalitiesList } = trpc.orthanc.modalities.useQuery(undefined, {
    enabled: isAuthenticated && showSendDialog,
  });

  const updateStatus = trpc.studies.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Statut mis à jour");
      utils.studies.list.invalidate();
    },
    onError: err =>
      toast.error(
        err.data?.code === "FORBIDDEN"
          ? "Action réservée aux radiologues/administrateurs"
          : err.message
      ),
  });
  const updatePriority = trpc.studies.updatePriority.useMutation({
    onSuccess: () => {
      toast.success("Priorité mise à jour");
      utils.studies.list.invalidate();
    },
    onError: err =>
      toast.error(
        err.data?.code === "FORBIDDEN"
          ? "Action réservée aux radiologues/administrateurs"
          : err.message
      ),
  });
  const cStore = trpc.orthanc.cStore.useMutation({
    onSuccess: res => {
      if (res.success) toast.success("Examen envoyé (C-STORE)");
      else toast.error(`Échec de l'envoi : ${res.message}`);
      setShowSendDialog(false);
    },
    onError: err =>
      toast.error(
        err.data?.code === "FORBIDDEN"
          ? "Envoi DICOM réservé aux administrateurs"
          : `Échec de l'envoi : ${err.message}`
      ),
  });

  // Écouter les commandes Eva pour contrôler l'app
  useEffect(() => {
    const onAlbum = (e: Event) => {
      const albumKey = (e as CustomEvent<string>).detail;
      if (!albumKey) return;
      // Gère "today:CT" → modality CT + timeFilter today
      const [prefix, modality] = albumKey.split(":");
      if (prefix === "today" && modality) {
        setSelectedAlbum("database");
        setSelectedModality(modality);
        setTimeFilter("today");
      } else {
        setSelectedAlbum(albumKey);
        setSelectedModality(null);
        setTimeFilter("none");
      }
    };
    const onSearch = (e: Event) => {
      setSearchQuery((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("eva:selectAlbum", onAlbum);
    window.addEventListener("eva:search", onSearch);
    return () => {
      window.removeEventListener("eva:selectAlbum", onAlbum);
      window.removeEventListener("eva:search", onSearch);
    };
  }, []);

  const allStudies = studiesData ?? [];
  // Filtrage par smart album (côté client) PUIS recherche multi-champs façon
  // Horos (« Search » ⌘F, insensible casse/accents, ET sur les mots).
  const albumStudies = allStudies.filter((s: any) =>
    albumMatches(s, selectedAlbum, openedIds)
  );
  const filteredStudies = searchQuery.trim()
    ? albumStudies.filter((s: any) => matchAllFields(s, searchQuery))
    : albumStudies;

  // Tri des colonnes (Story 5.1). sortKey null = ordre naturel du backend
  // (date décroissante). Clic sur un en-tête : asc → desc → naturel.
  const studies = useMemo(
    () => sortStudies(filteredStudies as any[], sortKey, sortDir),
    [filteredStudies, sortKey, sortDir]
  );

  const toggleSort = (key: SortKey) => {
    const n = nextSort({ key: sortKey, dir: sortDir }, key);
    setSortKey(n.key);
    setSortDir(n.dir);
  };

  // Ouvre une étude dans le viewer en l'enregistrant comme « récemment ouverte »
  // (alimente le smart album « Just Opened »).
  const openStudy = useCallback(
    (id: number) => {
      setOpenedIds(recordOpenedId(id));
      navigate(`/viewer/${id}`);
    },
    [navigate]
  );
  const selectedStudy = studies.find((s: any) => s.id === selectedStudyId);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setShowImportDialog(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  if (!isAuthenticated && !loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-6 p-8">
          <div className="flex justify-center">
            <div className="w-20 h-20 rounded-2xl bg-primary/20 flex items-center justify-center">
              <MonitorUp className="w-10 h-10 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-foreground">MediView</h1>
          <p className="text-muted-foreground max-w-md">
            Professional DICOM Medical Imaging Viewer. Sign in to access patient
            studies and imaging data.
          </p>
          <Button
            size="lg"
            onClick={() => (window.location.href = getLoginUrl())}
            className="gap-2"
          >
            <LogIn className="w-4 h-4" />
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-background"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Menu Bar (like Horos top menu) */}
      <div className="h-7 bg-[#1a1a2e] border-b border-border/50 flex items-center px-3 text-[11px] text-muted-foreground shrink-0">
        <div className="flex items-center gap-1">
          <span className="font-semibold text-primary mr-3">MediView</span>
          {/* File Menu */}
          <MenuDropdown
            label="File"
            items={[
              {
                label: "Import DICOM...",
                onClick: () => setShowImportDialog(true),
              },
              {
                label: "Export Selection...",
                onClick: () => {
                  if (selectedStudyId) setShowExportDialog(true);
                  else toast("Select a study first");
                },
              },
              {
                label: "Generate Report (PDF)",
                onClick: () => {
                  if (selectedStudyId) setShowExportDialog(true);
                  else toast("Select a study first");
                },
              },
              {
                label: "Partager…",
                onClick: () => {
                  if (selectedStudyId) setShareOpen(true);
                  else toast("Select a study first");
                },
              },
              {
                label: "Delete Study",
                onClick: () => {
                  if (selectedStudyId) toast("Delete requires admin role");
                  else toast("Select a study first");
                },
              },
            ]}
          />
          {/* Network Menu */}
          <MenuDropdown
            label="Network"
            items={[
              { label: "Query PACS...", onClick: () => setShowQueryPACS(true) },
              {
                label: "Add PACS Server...",
                onClick: () => setShowAddServer(true),
              },
              {
                label: "Send Study (C-STORE)",
                onClick: () => toast("Configure a PACS server first"),
              },
              {
                label: "Retrieve Study (C-MOVE)",
                onClick: () => toast("Configure a PACS server first"),
              },
            ]}
          />
          {/* Edit Menu */}
          <MenuDropdown
            label="Edit"
            items={[
              { label: "Select All", onClick: () => toast("Select All") },
              {
                label: "Deselect All",
                onClick: () => setSelectedStudyId(null),
              },
              {
                label: "Anonymize...",
                onClick: () => {
                  if (selectedStudyId) setShowAnonymizeDialog(true);
                  else toast("Select a study first");
                },
              },
              {
                label: "Meta-Data...",
                onClick: () => {
                  if (selectedStudyId) setShowMetaData(true);
                  else toast("Select a study first");
                },
              },
            ]}
          />
          {/* Format Menu */}
          <MenuDropdown
            label="Format"
            items={[
              {
                label: "Window/Level Presets",
                onClick: () =>
                  toast("Open a study in the viewer to adjust W/L"),
              },
              {
                label: "Invert",
                onClick: () => toast("Open a study in the viewer"),
              },
              {
                label: "Reset Window",
                onClick: () => toast("Open a study in the viewer"),
              },
            ]}
          />
          <MenuBarItem
            label="2D Viewer"
            onClick={() => {
              if (selectedStudyId) openStudy(selectedStudyId);
              else toast("Select a study first");
            }}
          />
          <MenuBarItem
            label="3D Viewer"
            onClick={() => {
              if (selectedStudyId) openStudy(selectedStudyId);
              else toast("Select a study first");
            }}
          />
          <MenuBarItem
            label="ROI"
            onClick={() => {
              if (selectedStudyId) openStudy(selectedStudyId);
              else toast("Select a study first");
            }}
          />
          <MenuBarItem
            label="Cockpit"
            onClick={() => setCockpitOpen(o => !o)}
          />
          {/* Plugins Menu */}
          <MenuDropdown
            label="Plugins"
            items={[
              {
                label: "Plugin Manager",
                onClick: () => toast("Plugin system coming soon"),
              },
              {
                label: "DICOM Print",
                onClick: () => toast("DICOM Print plugin coming soon"),
              },
              {
                label: "Hanging Protocols",
                onClick: () => toast("Hanging Protocols coming soon"),
              },
            ]}
          />
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <span className="text-[10px]">Recent Studies</span>
          <NotificationsPanel />
          <div className="flex items-center gap-1.5">
            <User className="w-3 h-3" />
            <span className="text-[10px]">{user?.name || "User"}</span>
          </div>
          <button
            onClick={() => {
              void logout().finally(() => navigate("/login"));
            }}
            title="Se déconnecter"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <LogOut className="w-3 h-3" />
            <span className="hidden sm:inline">Déconnexion</span>
          </button>
        </div>
      </div>

      {/* Top Toolbar - Horos style with all buttons */}
      <div className="h-16 border-b border-border bg-gradient-to-b from-[#2a2a3e] to-[#1e1e30] flex items-center px-2 gap-0.5 shrink-0">
        <ToolbarButton
          icon={LayoutDashboard}
          label="Cockpit"
          onClick={() => setCockpitOpen(o => !o)}
        />
        <ToolbarSep />
        <ToolbarButton
          icon={Cloud}
          label="Cloud Dashboard"
          onClick={() => toast("Cloud Dashboard coming soon")}
        />
        <ToolbarButton
          icon={FileText}
          label="Cloud Report"
          onClick={() => toast("Cloud Report coming soon")}
        />
        <ToolbarButton
          icon={Send}
          label="Cloud Sharing"
          onClick={() => {
            if (selectedStudyId) setShareOpen(true);
            else toast("Sélectionnez une étude");
          }}
        />
        <ToolbarSep />
        <ToolbarButton
          icon={Upload}
          label="Import"
          onClick={() => setShowImportDialog(true)}
          active
        />
        <ToolbarButton
          icon={Film}
          label="Movie Export"
          onClick={() => toast("Movie Export coming soon")}
        />
        <ToolbarButton
          icon={Download}
          label="Export"
          onClick={() => {
            if (selectedStudyId) setShowExportDialog(true);
            else toast("Select a study first");
          }}
        />
        <ToolbarButton
          icon={Mail}
          label="Email"
          onClick={() => toast("Email - configure SMTP in settings")}
        />
        <ToolbarButton
          icon={Send}
          label="Send"
          onClick={() => {
            if (!selectedStudyId) {
              toast("Sélectionnez d'abord un examen");
              return;
            }
            setSendTargetAet("");
            setShowSendDialog(true);
          }}
        />
        <ToolbarSep />
        <ToolbarButton
          icon={Search}
          label="Query"
          onClick={() => setShowQueryPACS(true)}
        />
        <ToolbarButton
          icon={ClipboardList}
          label="Worklist"
          onClick={() => setShowWorklist(true)}
        />
        <ToolbarButton
          icon={Shield}
          label="Anonymize"
          onClick={() => {
            if (selectedStudyId) setShowAnonymizeDialog(true);
            else toast("Select a study first");
          }}
        />
        <ToolbarButton
          icon={Disc}
          label="Burn"
          onClick={() => toast("Burn to CD/DVD coming soon")}
        />
        <ToolbarButton
          icon={Info}
          label="Meta-Data"
          onClick={() => {
            if (selectedStudyId) setShowMetaData(true);
            else toast("Select a study first");
          }}
        />
        <ToolbarButton
          icon={Trash2}
          label="Delete"
          onClick={() => {
            if (selectedStudyId) {
              if (
                confirm(
                  "Are you sure you want to delete this study? This action cannot be undone."
                )
              ) {
                deleteStudy.mutate({ id: selectedStudyId });
              }
            } else toast("Select a study first");
          }}
        />
        <ToolbarSep />
        <ToolbarButton
          icon={Monitor}
          label="Viewers"
          onClick={() => toast("Viewer layout options coming soon")}
        />
        <ToolbarButton
          icon={Eye}
          label="2D Viewer"
          onClick={() => {
            if (selectedStudyId) openStudy(selectedStudyId);
            else toast("Select a study to open viewer");
          }}
        />
        <ToolbarButton
          icon={PenTool}
          label="ROIs & Keys"
          onClick={() => {
            if (selectedStudyId) openStudy(selectedStudyId);
            else toast("Select a study first");
          }}
        />
        <ToolbarButton
          icon={Layers}
          label="4D Viewer"
          onClick={() => {
            if (selectedStudyId) openStudy(selectedStudyId);
            else toast("4D Viewer coming soon");
          }}
        />
        <ToolbarButton
          icon={FileText}
          label="Report"
          onClick={() => {
            if (selectedStudyId) setShowExportDialog(true);
            else toast("Select a study first");
          }}
        />
        <ToolbarSep />
        <ToolbarButton
          icon={Timer}
          label="Time Interval"
          onClick={() => toast("Use the time filter dropdown")}
        />

        <div className="flex-1" />

        {/* Time filter */}
        <select
          className="bg-secondary/50 text-secondary-foreground text-[10px] px-2 py-1 rounded border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary mr-2"
          value={timeFilter}
          onChange={e => setTimeFilter(e.target.value)}
        >
          {TIME_FILTERS.map(f => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>

        {/* Modality filter */}
        <select
          className="bg-secondary/50 text-secondary-foreground text-[10px] px-2 py-1 rounded border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary"
          value={selectedModality || "all"}
          onChange={e =>
            setSelectedModality(
              e.target.value === "all" ? null : e.target.value
            )
          }
        >
          <option value="all">All modalities</option>
          {ALL_MODALITIES.map(m => (
            <option key={m.key} value={m.key}>
              {m.key}
            </option>
          ))}
        </select>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden min-w-0">
        {cockpitOpen && (
          <div className="w-64 lg:w-72 shrink-0 border-r border-slate-800 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              }
            >
              <CockpitMediView embedded />
            </Suspense>
          </div>
        )}
        {/* Albums sidebar — masquée sur petit écran quand Eva est ouverte */}
        <div
          className={`border-r border-border bg-sidebar flex flex-col shrink-0 ${cockpitOpen ? "hidden md:flex w-44 lg:w-52" : "w-52"}`}
        >
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Albums */}
            <div className="p-3">
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Albums
              </h3>
              <div className="space-y-0.5">
                {SMART_ALBUMS.map(album => (
                  <button
                    key={album.key}
                    onClick={() => setSelectedAlbum(album.key)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                      selectedAlbum === album.key
                        ? "bg-primary/20 text-primary"
                        : "text-sidebar-foreground hover:bg-sidebar-accent"
                    }`}
                  >
                    <album.icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{album.label}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {
                        allStudies.filter((s: any) =>
                          albumMatches(s, album.key, openedIds)
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            {/* File à signer — brouillons IA en attente de signature */}
            <div className="p-3">
              <PendingSignatureList onOpen={openStudy} />
            </div>

            <Separator />

            {/* Recherche patient Hermès */}
            <div className="p-3">
              <HermesFinder onOpen={openStudy} />
            </div>

            <Separator />

            {/* Today's Studies by modality */}
            <div className="p-3">
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Today's Studies
              </h3>
              <div className="space-y-0.5">
                {ALL_MODALITIES.slice(0, 10).map(mod => {
                  const albumKey = `today:${mod.key}`;
                  const count = allStudies.filter((s: any) =>
                    albumMatches(s, albumKey, openedIds)
                  ).length;
                  return (
                    <button
                      key={mod.key}
                      onClick={() =>
                        setSelectedAlbum(
                          selectedAlbum === albumKey ? "database" : albumKey
                        )
                      }
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                        selectedAlbum === albumKey
                          ? "bg-primary/20 text-primary"
                          : "text-sidebar-foreground hover:bg-sidebar-accent"
                      }`}
                    >
                      <span className="w-6 font-mono text-[10px] shrink-0">
                        {mod.key}
                      </span>
                      <span className="truncate text-[10px]">
                        {mod.description}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* Sources */}
            <div className="p-3">
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center justify-between">
                <span>Sources</span>
                <button
                  onClick={() => setShowAddServer(true)}
                  className="hover:text-primary"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </h3>
              <div className="space-y-0.5">
                <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-primary/10 text-primary">
                  <Database className="w-3.5 h-3.5" />
                  <span>Documents DB</span>
                </button>
                {(pacsServersList || []).map((srv: any) => (
                  <button
                    key={srv.id}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-sidebar-foreground hover:bg-sidebar-accent group"
                    onClick={() => setShowQueryPACS(true)}
                  >
                    <Server className="w-3.5 h-3.5" />
                    <span className="text-[10px] flex-1 text-left truncate">
                      {srv.name}
                    </span>
                    <Trash2
                      className="w-3 h-3 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                      onClick={e => {
                        e.stopPropagation();
                        deletePacsServer.mutate({ id: srv.id });
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            {/* Réglages agent CR autonome */}
            <div className="p-3">
              <AgentCrSettings />
            </div>

            <Separator />

            {/* Dashboard agents Hermès */}
            <div className="p-3">
              <AgentsDashboard />
            </div>

            <Separator />

            {/* Carnet des référents */}
            <div className="p-3">
              <ReferentDirectory />
            </div>
          </div>

          {/* Activity */}
          <div className="p-3 border-t border-border">
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              Activity
            </h3>
            {(() => {
              const recent = openedIds
                .map(id => allStudies.find((s: any) => s.id === id))
                .filter(Boolean)
                .slice(0, 6);
              if (recent.length === 0)
                return (
                  <p className="text-[10px] text-muted-foreground">
                    Aucune activité récente
                  </p>
                );
              return (
                <div className="space-y-0.5">
                  {recent.map((s: any) => (
                    <button
                      key={s.id}
                      onClick={() => navigate(`/viewer/${s.id}`)}
                      className="w-full text-left text-[10px] text-muted-foreground hover:text-foreground truncate"
                      title={`${s.patientName || "?"} — ${s.modality || ""} ${s.studyDescription || ""}`}
                    >
                      • {s.patientName || "Sans nom"}{" "}
                      <span className="opacity-60">{s.modality || ""}</span>
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Main Study List */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Recherche multi-champs (Search ⌘F de Horos) */}
          <div className="h-9 border-b border-border bg-card flex items-center gap-2 px-2 shrink-0">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Rechercher (nom, ID, accession, modalité, description…)"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border"
              >
                {studies.length} résultat{studies.length > 1 ? "s" : ""} ✕
              </button>
            )}
          </div>
          {/* Column Headers - Horos style with all columns. Les colonnes
              triables (Story 5.1) sont des boutons ; flèche = sens actif. */}
          <div className="h-8 border-b border-border bg-card/50 flex items-center px-2 text-[10px] font-medium text-muted-foreground shrink-0 select-none">
            <SortHeader
              label="Patient name"
              col="patientName"
              className="w-36"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <div className="w-16 px-1">Report</div>
            <div className="w-10 px-1">Lock</div>
            <SortHeader
              label="Patient ID"
              col="patientDicomId"
              className="w-24"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <div className="w-12 px-1">Age</div>
            <SortHeader
              label="Accession Number"
              col="accessionNumber"
              className="w-28"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label="Study Description"
              col="studyDescription"
              className="w-40"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label="Modality"
              col="modality"
              className="w-14"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label="ID"
              col="id"
              className="w-20"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label="Date exam."
              col="studyDate"
              className="w-24"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <div className="w-16 px-1">History</div>
          </div>

          {/* Study Rows */}
          <ScrollArea className="flex-1 min-h-0">
            {studiesLoading ? (
              <div className="flex items-center justify-center h-48">
                <div className="text-sm text-muted-foreground">
                  Loading studies...
                </div>
              </div>
            ) : studies.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 p-8">
                <Database className="w-12 h-12 text-muted-foreground/30" />
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">
                    No studies in database
                  </p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Import DICOM files by dragging them here or using the Import
                    button
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowImportDialog(true)}
                  className="gap-2"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Import DICOM
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {studies.map((study: any) => (
                  <div
                    key={study.id}
                    role="button"
                    tabIndex={0}
                    className={`w-full flex items-center px-2 py-1.5 text-[10px] hover:bg-accent/50 transition-colors text-left cursor-pointer ${
                      selectedStudyId === study.id
                        ? "bg-primary/15 ring-1 ring-primary/40"
                        : ""
                    }`}
                    onClick={() => setSelectedStudyId(study.id)}
                    onDoubleClick={() => openStudy(study.id)}
                  >
                    <div className="w-36 px-1 font-medium truncate text-foreground">
                      {study.patientName || "-"}
                    </div>
                    <div
                      className="w-24 px-1 text-muted-foreground"
                      onClick={e => e.stopPropagation()}
                    >
                      {canEditWorkflow ? (
                        <Select
                          value={study.status ?? "new"}
                          onValueChange={value =>
                            updateStatus.mutate({
                              id: study.id,
                              status: value as
                                | "new"
                                | "in_progress"
                                | "reported"
                                | "finalized",
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-6 text-[9px] px-1.5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="new">Nouveau</SelectItem>
                            <SelectItem value="in_progress">
                              En cours
                            </SelectItem>
                            <SelectItem value="reported">Rapporté</SelectItem>
                            <SelectItem value="finalized">Finalisé</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : study.status === "reported" ? (
                        <Badge
                          variant="secondary"
                          className="text-[8px] px-1 py-0"
                        >
                          Done
                        </Badge>
                      ) : (
                        "-"
                      )}
                    </div>
                    <div
                      className="w-24 px-1 text-muted-foreground"
                      onClick={e => e.stopPropagation()}
                    >
                      {canEditWorkflow ? (
                        <Select
                          value={study.priority ?? "routine"}
                          onValueChange={value =>
                            updatePriority.mutate({
                              id: study.id,
                              priority: value as "routine" | "stat" | "urgent",
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-6 text-[9px] px-1.5"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="routine">Routine</SelectItem>
                            <SelectItem value="stat">STAT</SelectItem>
                            <SelectItem value="urgent">Urgent</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : study.priority === "stat" ? (
                        <Lock className="w-3 h-3 text-destructive" />
                      ) : (
                        "-"
                      )}
                    </div>
                    <div className="w-24 px-1 text-muted-foreground truncate">
                      {study.patientDicomId || "-"}
                    </div>
                    <div className="w-12 px-1 text-muted-foreground">
                      {calculateAge(study.birthDate) || "-"}
                    </div>
                    <div className="w-28 px-1 text-muted-foreground truncate">
                      {study.accessionNumber || "-"}
                    </div>
                    <div className="w-40 px-1 text-muted-foreground truncate">
                      {study.studyDescription || "-"}
                    </div>
                    <div className="w-14 px-1">
                      <Badge
                        variant="secondary"
                        className="text-[8px] px-1 py-0 font-mono"
                      >
                        {study.modality || "-"}
                      </Badge>
                    </div>
                    <div className="w-20 px-1 text-muted-foreground truncate text-[9px]">
                      {study.studyInstanceUid?.slice(-8) || "-"}
                    </div>
                    <div className="w-24 px-1 text-muted-foreground tabular-nums text-[10px]">
                      {formatStudyDate(study.studyDate)}
                    </div>
                    <div className="w-16 px-1 text-muted-foreground text-[9px]">
                      {study.numberOfSeries
                        ? `${study.numberOfSeries}S/${study.numberOfInstances}I`
                        : "-"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      {/* Status Bar - Horos style */}
      <div className="h-6 border-t border-border bg-[#1a1a2e] flex items-center px-3 text-[10px] text-muted-foreground shrink-0">
        <span>
          Local Database: Documents DB /{" "}
          {selectedAlbum === "database"
            ? "No album selection"
            : SMART_ALBUMS.find(a => a.key === selectedAlbum)?.label}
        </span>
        <div className="flex-1" />
        <span>{studies.length} studies</span>
        <span className="mx-3">|</span>
        <span>MediView v1.0</span>
      </div>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import DICOM Files</DialogTitle>
          </DialogHeader>
          <DicomImport onComplete={() => setShowImportDialog(false)} />
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <ExportPanel
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        studyId={selectedStudyId || undefined}
      />

      {/* Anonymize Dialog */}
      <AnonymizeDialog
        open={showAnonymizeDialog}
        onOpenChange={setShowAnonymizeDialog}
        studyId={selectedStudyId || undefined}
      />

      {/* Query PACS Dialog */}
      <QueryPACS open={showQueryPACS} onOpenChange={setShowQueryPACS} />

      <WorklistDialog open={showWorklist} onOpenChange={setShowWorklist} />

      <ShareStudyDialog
        studyId={selectedStudyId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />

      {/* Add PACS Server Dialog */}
      <Dialog open={showAddServer} onOpenChange={setShowAddServer}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add PACS Server</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={e => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              createPacsServer.mutate({
                name: fd.get("name") as string,
                aeTitle: fd.get("aeTitle") as string,
                host: fd.get("host") as string,
                port: parseInt(fd.get("port") as string) || 4242,
                orthancUrl: (fd.get("orthancUrl") as string) || undefined,
              });
              setShowAddServer(false);
            }}
          >
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                Server Name *
              </label>
              <input
                name="name"
                required
                className="w-full px-3 py-1.5 rounded bg-background border border-border text-sm"
                placeholder="MAC-IRM"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                AE Title *
              </label>
              <input
                name="aeTitle"
                required
                className="w-full px-3 py-1.5 rounded bg-background border border-border text-sm"
                placeholder="HOROS"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Host *</label>
                <input
                  name="host"
                  required
                  className="w-full px-3 py-1.5 rounded bg-background border border-border text-sm"
                  placeholder="192.168.1.100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Port</label>
                <input
                  name="port"
                  type="number"
                  defaultValue="4242"
                  className="w-full px-3 py-1.5 rounded bg-background border border-border text-sm"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                Orthanc URL (optional)
              </label>
              <input
                name="orthancUrl"
                className="w-full px-3 py-1.5 rounded bg-background border border-border text-sm"
                placeholder="http://localhost:8042"
              />
            </div>
            <Button type="submit" className="w-full">
              Add Server
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Meta-Data Dialog */}
      <Dialog open={showMetaData} onOpenChange={setShowMetaData}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>DICOM Meta-Data</DialogTitle>
          </DialogHeader>
          <div className="text-xs text-muted-foreground">
            {selectedStudyId ? (
              <MetaDataView studyId={selectedStudyId} />
            ) : (
              <p>No study selected</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* DICOM Send (C-STORE) Dialog */}
      <Dialog open={showSendDialog} onOpenChange={setShowSendDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Envoyer l'examen (C-STORE)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Envoyer{" "}
              <span className="font-medium text-foreground">
                {selectedStudy?.patientName || "l'examen sélectionné"}
              </span>{" "}
              vers une modalité distante (PACS). Réservé aux administrateurs.
            </p>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">
                Modalité de destination (AE Title)
              </label>
              <Select value={sendTargetAet} onValueChange={setSendTargetAet}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choisir une modalité…" />
                </SelectTrigger>
                <SelectContent>
                  {(modalitiesList ?? []).length === 0 ? (
                    <SelectItem value="__none" disabled>
                      Aucune modalité configurée
                    </SelectItem>
                  ) : (
                    (modalitiesList ?? []).map((aet: string) => (
                      <SelectItem key={aet} value={aet}>
                        {aet}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSendDialog(false)}
              >
                Annuler
              </Button>
              <Button
                size="sm"
                disabled={
                  !sendTargetAet ||
                  !selectedStudy?.studyInstanceUid ||
                  cStore.isPending
                }
                onClick={() => {
                  if (!selectedStudy?.studyInstanceUid) return;
                  cStore.mutate({
                    targetAet: sendTargetAet,
                    studyInstanceUID: selectedStudy.studyInstanceUid,
                  });
                }}
              >
                {cStore.isPending ? "Envoi…" : "Envoyer"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MenuDropdown({
  label,
  items,
}: {
  label: string;
  items: { label: string; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        className="px-2 py-0.5 rounded hover:bg-white/10 transition-colors text-[11px] text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
      {open && (
        // Pas de marge (mt-*) entre le bouton et la liste : une marge créerait une
        // zone morte que la souris traverse en descendant → onMouseLeave fermerait
        // le menu avant qu'on l'atteigne. La liste est accolée au bouton (top-full),
        // donc le survol reste continu du bouton vers les items.
        <div className="absolute top-full left-0 w-48 bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          {items.map(item => (
            <button
              key={item.label}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuBarItem({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded hover:bg-white/10 transition-colors text-[11px] text-muted-foreground hover:text-foreground"
    >
      {label}
    </button>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: any;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`toolbar-btn ${active ? "active" : ""}`}
      title={label}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[9px] leading-tight">{label}</span>
    </button>
  );
}

function ToolbarSep() {
  return <Separator orientation="vertical" className="h-10 mx-1 opacity-30" />;
}

function MetaDataView({ studyId }: { studyId: number }) {
  const { data: study } = trpc.studies.get.useQuery({ id: studyId });

  if (!study) return <p>Loading...</p>;

  const fields = [
    ["Patient Name", study.patientName],
    ["Patient ID", study.patientId],
    ["Birth Date", study.birthDate],
    ["Study Date", study.studyDate],
    ["Study Description", study.studyDescription],
    ["Modality", study.modality],
    ["Referring Physician", study.referringPhysician],
    ["Performing Physician", study.performingPhysician],
    ["Institution", study.institution],
    ["Study Instance UID", study.studyInstanceUid],
    ["Number of Series", study.numberOfSeries],
    ["Number of Instances", study.numberOfInstances],
    ["Status", study.status],
    ["Priority", study.priority],
  ];

  return (
    <ScrollArea className="max-h-[60vh]">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-1 px-2 text-muted-foreground font-medium">
              Tag
            </th>
            <th className="text-left py-1 px-2 text-muted-foreground font-medium">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map(([tag, value]) => (
            <tr
              key={tag}
              className="border-b border-border/30 hover:bg-accent/30"
            >
              <td className="py-1 px-2 text-muted-foreground">{tag}</td>
              <td className="py-1 px-2 text-foreground font-mono">
                {value || "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function calculateAge(birthDate?: string | null): string {
  if (!birthDate) return "";
  try {
    const birth = new Date(
      birthDate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
    );
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age > 0 ? `${age}Y` : "";
  } catch {
    return "";
  }
}
