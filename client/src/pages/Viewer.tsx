import { useAuth } from "@/_core/hooks/useAuth";
import CornerstoneViewer, {
  type CornerstoneViewerHandle,
} from "@/components/CornerstoneViewer";
import VolumeViewer, { PRESETS_3D } from "@/components/VolumeViewer";
import { SLAB_MODES, type SlabMode } from "@/lib/slabBlend";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  Move,
  RotateCw,
  Maximize,
  Ruler,
  Circle,
  Square,
  Type,
  Crosshair,
  Sun,
  Contrast,
  Layers,
  Grid3X3,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Download,
  Printer,
  Mail,
  Camera,
  FlipHorizontal,
  FlipVertical,
  TriangleAlert,
  ImagePlus,
  FileText,
  Keyboard,
  Triangle,
  MoveDiagonal,
  MapPin,
  Spline,
  Columns2,
  Grid2x2,
  Brush,
  Eraser,
  Trash2,
  Box,
  SquareDashedBottom,
} from "lucide-react";
import {
  type RedactionRect,
  normalizeRect,
  isNegligibleRect,
  compositeRedactedCanvas,
} from "@/lib/redaction";
import {
  polyDataArraysToObj,
  polyDataArraysStats,
  sampleVolumeTrilinear,
  huToRgb,
  worldToIndex,
} from "@/lib/objExport";
import { downsampleScalarVolume } from "@/lib/volumeDownsample";
import { meshToBinaryPly } from "@/lib/plyExport";
import { meshToGlb, polysToTriangleIndices } from "@/lib/glbExport";
import {
  buildVertexAdjacency,
  taubinSmooth,
  computeVertexNormals,
} from "@/lib/meshSmooth";
import ReportPanel, { type ReportKeyImage } from "@/components/ReportPanel";
import CurvedMprPanel from "@/components/CurvedMprPanel";
import SeriesThumbnail from "@/components/SeriesThumbnail";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { COLORMAPS, getColormapLut } from "@/lib/colormaps";
import { getPresetsForModality } from "@/lib/windowPresets";
import { sortByInstanceNumber, sortBySliceLocation } from "@/lib/sortSeries";
import { edgeLabelsFromIop } from "@/lib/orientationLabels";
import { toggleKeyImage, nextKeyImage, prevKeyImage } from "@/lib/keyImages";
import { findPriors } from "@/lib/priorStudies";
import { Palette, Star } from "lucide-react";
import {
  CINE_FPS_OPTIONS,
  DEFAULT_CINE_FPS,
  nextCineIndex,
  fpsToIntervalMs,
} from "@/lib/cine";
import { resolveShortcut, shortcutLegend } from "@/lib/keyboardShortcuts";
import {
  type ViewportLayout,
  layoutCellCount,
  layoutGridClass,
  clampActiveCell,
} from "@/lib/viewportLayout";
import { pickHangingProtocol } from "@/lib/hangingProtocols";
import {
  findPetSeries,
  PET_COLORMAPS,
  DEFAULT_PET_COLORMAP_ID,
} from "@/lib/petFusion";
import {
  computeSuvFactor,
  extractSuvMetadataFromDataset,
  type SuvFactorResult,
} from "@/lib/suv";
import { toast } from "sonner";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// Window/Level presets for different body parts
const WL_PRESETS = [
  { name: "Default", ww: 400, wc: 40 },
  { name: "Bone", ww: 2000, wc: 500 },
  { name: "Lung", ww: 1500, wc: -600 },
  { name: "Brain", ww: 80, wc: 40 },
  { name: "Abdomen", ww: 350, wc: 50 },
  { name: "Liver", ww: 150, wc: 30 },
  { name: "Mediastinum", ww: 350, wc: 50 },
];

// Presets accessibles depuis la barre du bas et les raccourcis 1..N.
const QUICK_PRESETS = WL_PRESETS.slice(0, 4);

// Viewer tools
const VIEWER_TOOLS = [
  { id: "wwwl", label: "W/L", icon: Contrast, description: "Window/Level" },
  { id: "zoom", label: "Zoom", icon: ZoomIn, description: "Zoom" },
  { id: "pan", label: "Pan", icon: Move, description: "Pan" },
  { id: "scroll", label: "Scroll", icon: Layers, description: "Stack Scroll" },
  {
    id: "length",
    label: "Length",
    icon: Ruler,
    description: "Length Measurement",
  },
  {
    id: "angle",
    label: "Angle",
    icon: TriangleAlert,
    description: "Angle Measurement",
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon: Circle,
    description: "Elliptical ROI",
  },
  { id: "rect", label: "Rect", icon: Square, description: "Rectangular ROI" },
  { id: "text", label: "Text", icon: Type, description: "Text Annotation" },
  {
    id: "cobb",
    label: "Cobb",
    icon: Triangle,
    description: "Angle de Cobb (rachis)",
  },
  {
    id: "bidirectional",
    label: "Bidir.",
    icon: MoveDiagonal,
    description: "Mesure bidirectionnelle (RECIST)",
  },
  {
    id: "probe",
    label: "Sonde",
    icon: MapPin,
    description: "Sonde — valeur HU ponctuelle",
  },
  {
    id: "freehand",
    label: "Main levée",
    icon: Spline,
    description: "ROI à main levée",
  },
  // NB : segmentation (Pinceau/Gomme) retirée de la barre — le labelmap stack
  // ne s'initialisait pas de façon fiable (métadonnées pas prêtes) → boutons
  // morts. À ré-intégrer proprement plus tard si besoin.
  // Caviardage (redaction) des PHI brûlés dans les pixels (US / capture
  // secondaire) : on trace un rectangle, masqué en noir et recomposé sur
  // toute image exportée. Calque overlay, pas un outil Cornerstone.
  {
    id: "redact",
    label: "Caviarder",
    icon: SquareDashedBottom,
    description:
      "Caviarder — masquer en noir une zone (PHI brûlé) ; appliqué aux exports",
  },
  // NB : pas d'outil « crosshair » ici — il n'existe pas dans le toolMap 2D et
  // sélectionnait un outil inconnu (cassait le changement d'outil). La MPR
  // s'active via le bouton de mode « MPR » dédié (VolumeViewport), pas un outil.
];

export default function Viewer() {
  const params = useParams<{ studyId?: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const studyId = params.studyId ? parseInt(params.studyId) : undefined;

  const [activeTool, setActiveTool] = useState("wwwl");
  // CLUT (palette couleur) appliquée au viewport actif ; null = niveaux de gris.
  const [activeColormap, setActiveColormap] = useState<string | null>(null);
  // Rotation absolue courante (0/90/180/270) pour le bouton « Rotation 90° ».
  const [imageRotation, setImageRotation] = useState(0);
  // Vidéo inversée (négatif) sur le viewport actif.
  const [imageInverted, setImageInverted] = useState(false);
  // Fonction VOI LUT : linéaire (défaut) ou sigmoïde (« Use VOI LUT » de Horos).
  const [voiLutFn, setVoiLutFn] = useState<"LINEAR" | "SIGMOID">("LINEAR");
  // Indices de coupes marquées « image clé » (« Key Image » ⌘K de Horos).
  const [keyImageSlices, setKeyImageSlices] = useState<number[]>([]);
  // Tri des coupes (« Sort By » de Horos) : clé + sens.
  const [sortKey, setSortKey] = useState<"instanceNumber" | "sliceLocation">(
    "instanceNumber"
  );
  const [sortAsc, setSortAsc] = useState(true);
  // Étiquettes d'orientation anatomique (A/P/L/R/H/F) aux bords du viewport.
  const [orientLabels, setOrientLabels] = useState<{
    top: string;
    bottom: string;
    left: string;
    right: string;
  } | null>(null);
  // Inspecteur de méta-données DICOM (« DICOM Meta-Data / ⌘I » de Horos).
  const [tagInspectorOpen, setTagInspectorOpen] = useState(false);
  const [dicomTags, setDicomTags] = useState<
    Array<{ tag: string; name: string; vr: string; value: string }>
  >([]);
  const [tagQuery, setTagQuery] = useState("");
  const [tagsLoading, setTagsLoading] = useState(false);

  const openTagInspector = useCallback(async () => {
    setTagInspectorOpen(true);
    setTagsLoading(true);
    try {
      const tags = (await activeViewerRef.current?.getDicomTags?.()) ?? [];
      setDicomTags(tags);
    } catch {
      setDicomTags([]);
    } finally {
      setTagsLoading(false);
    }
  }, []);
  const [currentSlice, setCurrentSlice] = useState(0);
  const [totalSlices, setTotalSlices] = useState(1);
  const [windowWidth, setWindowWidth] = useState(400);
  const [windowCenter, setWindowCenter] = useState(40);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [selectedSeries, setSelectedSeries] = useState<number | null>(null);
  const [viewportLayout, setViewportLayout] = useState<ViewportLayout>("1x1");
  // Cellule active de la grille multi-viewports : c'est elle que pilotent la
  // barre d'outils, les presets W/L, les contrôles de coupe, la capture et le
  // compte rendu. En 1x1 il n'y a qu'une cellule (index 0).
  const [activeCell, setActiveCell] = useState(0);
  const [viewMode, setViewMode] = useState<"2d" | "mpr" | "3d">("2d");
  const [preset3d, setPreset3d] = useState<string>("os");
  // Rendu réaliste 3D (éclairage cinématique + qualité accrue). ON par défaut ;
  // l'utilisateur peut le couper si c'est trop lent sur sa machine.
  const [realistic3d, setRealistic3d] = useState<boolean>(true);
  // Export maillage 3D (.obj) : seuil HU de l'isosurface (≈300 = os) + état de
  // génération (les marching cubes sur un volume CT complet sont lourds).
  const [meshThreshold, setMeshThreshold] = useState<number>(300);
  const [meshExporting, setMeshExporting] = useState(false);
  // Résolution du maillage exporté : facteur de sous-échantillonnage du volume
  // (1 = pleine, 2 = ½ par axe ≈ 1/8 des voxels, 4 = ¼ ≈ 1/64). Défaut Moyenne
  // pour garder des fichiers raisonnables.
  const [meshFactor, setMeshFactor] = useState<number>(2);
  // Format d'export : "ply" (binaire compact, défaut), "obj" (texte) ou "glb".
  const [meshFormat, setMeshFormat] = useState<"ply" | "obj" | "glb">("ply");
  // Lissage de Taubin du maillage avant export (atténue l'aliasing en escalier
  // des marching cubes sans rétrécir le volume). Activé par défaut.
  const [meshSmoothing, setMeshSmoothing] = useState<boolean>(true);
  const [huStats, setHuStats] = useState<{
    mean: number;
    stdDev: number;
    min: number;
    max: number;
    area: number;
    histogram?: number[];
  } | null>(null);
  const [slabThicknessMm, setSlabThicknessMm] = useState(0);
  const [slabMode, setSlabMode] = useState<SlabMode>("mip");
  // ── Fusion PET-CT (MPR) ─────────────────────────────────────────────────
  // Série PET choisie pour la superposition (null = fusion désactivée), opacité
  // de fusion (0..1) et colormap. Fonctionnel uniquement si l'étude contient une
  // série de modalité PT ; sinon le contrôle est affiché désactivé.
  const [fusionPetSeries, setFusionPetSeries] = useState<number | null>(null);
  const [fusionOpacity, setFusionOpacity] = useState<number>(0.5);
  const [petColormapId, setPetColormapId] = useState<string>(
    DEFAULT_PET_COLORMAP_ID
  );
  // Résultat du calcul du facteur SUV (lu des métadonnées DICOM de la série PET
  // fusionnée). null tant que non calculé / indisponible.
  const [suvResult, setSuvResult] = useState<SuvFactorResult | null>(null);
  // Panneau Curved MPR (bêta) — overlay autonome, ne touche pas aux viewports.
  const [curvedMprOpen, setCurvedMprOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportKeyImages, setReportKeyImages] = useState<ReportKeyImage[]>([]);

  // Caviardage (PHI brûlé) : rectangles de masquage stockés PAR IMAGE
  // (série + coupe), en fractions du viewport. Recomposés en noir opaque sur
  // toute image capturée/exportée pour garantir le retrait du PHI.
  const [redactionsByImage, setRedactionsByImage] = useState<
    Record<string, RedactionRect[]>
  >({});
  // Glissé en cours (en px conteneur) pendant le tracé du rectangle.
  const [redactDraft, setRedactDraft] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);
  // Clé d'image courante = série + coupe affichée.
  const redactionKey = `${selectedSeries ?? "none"}#${currentSlice}`;
  const currentRedactions = redactionsByImage[redactionKey] ?? [];
  // Caviardage en 1×1 uniquement : en mosaïque, le canvas exporté est une seule
  // cellule, les fractions du viewport plein ne correspondraient pas.
  const redactActive =
    viewMode === "2d" && viewportLayout === "1x1" && activeTool === "redact";

  // Ciné / boucle : lecture automatique de la pile de coupes.
  const [cinePlaying, setCinePlaying] = useState(false);
  const [cineFps, setCineFps] = useState<number>(DEFAULT_CINE_FPS);
  // Aide raccourcis clavier.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  // Réf vers le viewer ACTIF (1x1 → l'unique ; mosaïque → la cellule active) pour
  // déclencher l'effacement de sa segmentation depuis la barre d'outils.
  const activeViewerRef = useRef<CornerstoneViewerHandle | null>(null);

  // Efface le labelmap du viewer actif (bouton « Effacer seg. »).
  const handleClearSegmentation = useCallback(() => {
    activeViewerRef.current?.clearSegmentation();
  }, []);

  // Caviardage : début du tracé (souris enfoncée sur le calque overlay).
  const handleRedactDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setRedactDraft({ startX: x, startY: y, curX: x, curY: y });
  };

  // Caviardage : déplacement pendant le tracé.
  const handleRedactMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!redactDraft) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setRedactDraft({
      ...redactDraft,
      curX: e.clientX - rect.left,
      curY: e.clientY - rect.top,
    });
  };

  // Caviardage : fin du tracé → normalise en fraction et enregistre par image.
  const handleRedactUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!redactDraft) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const r = normalizeRect(
      redactDraft.startX,
      redactDraft.startY,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height
    );
    setRedactDraft(null);
    if (isNegligibleRect(r)) return; // clic accidentel : on ignore
    setRedactionsByImage(prev => ({
      ...prev,
      [redactionKey]: [...(prev[redactionKey] ?? []), r],
    }));
    toast.success("Zone caviardée ajoutée (appliquée aux exports)");
  };

  // Retire le dernier caviardage de l'image courante.
  const undoRedaction = () => {
    setRedactionsByImage(prev => {
      const list = prev[redactionKey] ?? [];
      if (list.length === 0) return prev;
      return { ...prev, [redactionKey]: list.slice(0, -1) };
    });
  };

  // Efface tous les caviardages de l'image courante.
  const clearRedactions = () => {
    setRedactionsByImage(prev => {
      if (!prev[redactionKey]?.length) return prev;
      const next = { ...prev };
      delete next[redactionKey];
      return next;
    });
  };

  // Fetch study data
  const { data: study } = trpc.studies.get.useQuery(
    { id: studyId! },
    { enabled: !!studyId }
  );

  // Antériorités / comparatif : toutes les études (pour rapprocher par patient).
  const { data: allStudiesData } = trpc.studies.list.useQuery(
    {},
    { enabled: !!study }
  );
  // Études antérieures du MÊME patient (tri date décroissante), via priorStudies.
  const priors = useMemo(() => {
    if (!study) return [] as any[];
    return findPriors(study as any, (allStudiesData ?? []) as any[]) as any[];
  }, [study, allStudiesData]);
  const [priorsOpen, setPriorsOpen] = useState(false);

  // Fetch series for this study
  const { data: seriesList } = trpc.series.listByStudy.useQuery(
    { studyId: studyId! },
    { enabled: !!studyId }
  );

  // Fetch instances for selected series
  const { data: instancesList } = trpc.instances.listBySeries.useQuery(
    { seriesId: selectedSeries! },
    { enabled: !!selectedSeries }
  );

  // Volume MPR/3D reconstruit depuis les coupes locales (MinIO, schéma wadouri:).
  // Mémoïsé : sinon une nouvelle référence de tableau à chaque rendu (scroll,
  // W/L, zoom…) relancerait l'effet de VolumeViewer et reconstruirait le volume.
  const volumeImageUrls = useMemo(
    () => (instancesList ?? []).map((inst: any) => inst.storageUrl || ""),
    [instancesList]
  );

  // Séries PET (modality PT) disponibles dans l'étude pour la fusion.
  const petSeriesOptions = useMemo(
    () => findPetSeries((seriesList ?? []) as any),
    [seriesList]
  );
  const hasPet = petSeriesOptions.length > 0;

  // Instances de la série PET choisie → URLs des coupes pour le 2e volume.
  const { data: petInstancesList } = trpc.instances.listBySeries.useQuery(
    { seriesId: fusionPetSeries! },
    { enabled: !!fusionPetSeries && viewMode === "mpr" }
  );
  const petImageUrls = useMemo(
    () => (petInstancesList ?? []).map((inst: any) => inst.storageUrl || ""),
    [petInstancesList]
  );
  // Fusion active uniquement en MPR, avec une série PET choisie ET ses coupes
  // chargées (≥ 2). Sinon on ne passe rien à VolumeViewer (rendu CT seul).
  const fusionActive =
    viewMode === "mpr" && !!fusionPetSeries && petImageUrls.length >= 2;

  // Calcul du facteur SUV depuis les métadonnées DICOM de la 1re coupe PET.
  // Best-effort + fail-safe : la coupe est décodée de façon asynchrone par le
  // loader (déclenché par VolumeViewer) → on tente quelques fois avant
  // d'abandonner. N'altère JAMAIS le rendu : ne fait que renseigner l'affichage.
  useEffect(() => {
    setSuvResult(null);
    if (!fusionActive || petImageUrls.length === 0) return;
    let cancelled = false;
    let tries = 0;
    const firstUrl = petImageUrls[0];
    const tick = async () => {
      if (cancelled) return;
      tries++;
      try {
        const loaderMod: any = await import(
          "@cornerstonejs/dicom-image-loader"
        );
        const wadouri = loaderMod?.wadouri ?? loaderMod?.default?.wadouri;
        const dataSet = wadouri?.dataSetCacheManager?.get?.(firstUrl);
        if (dataSet) {
          const meta = extractSuvMetadataFromDataset(dataSet);
          if (!cancelled) setSuvResult(computeSuvFactor(meta));
          return;
        }
      } catch {
        // loader indisponible → on cesse poliment
        return;
      }
      if (tries < 10 && !cancelled) setTimeout(tick, 800);
    };
    const t = setTimeout(tick, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fusionActive, petImageUrls]);

  // Coupes triées selon le mode « Sort By » (n° d'instance / position, ↑↓).
  // Par défaut n° d'instance croissant = ordre serveur historique inchangé.
  const sortedInstances = useMemo(() => {
    const list = (instancesList ?? []) as any[];
    return sortKey === "sliceLocation"
      ? sortBySliceLocation(list, sortAsc)
      : sortByInstanceNumber(list, sortAsc);
  }, [instancesList, sortKey, sortAsc]);

  // Dégradé CSS de la barre CLUT (« Color Look Up Table Bar ») : construit à
  // partir du LUT 256³ de la palette active, échantillonné en 17 paliers. Bas =
  // valeur basse, haut = valeur haute (sens Horos). null si pas de CLUT.
  const clutGradient = useMemo(() => {
    if (!activeColormap) return null;
    try {
      const lut = getColormapLut(activeColormap);
      const stops: string[] = [];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const idx = Math.round((i / n) * 255);
        const r = lut[idx * 3];
        const g = lut[idx * 3 + 1];
        const b = lut[idx * 3 + 2];
        stops.push(`rgb(${r},${g},${b}) ${(i / n) * 100}%`);
      }
      return `linear-gradient(to top, ${stops.join(", ")})`;
    } catch {
      return null;
    }
  }, [activeColormap]);

  // Tableaux mémoïsés réutilisés par chaque cellule de la mosaïque (référence
  // stable → pas de re-setup parasite du viewport au scroll/W/L).
  const cellImageUrls = useMemo(
    () => sortedInstances.map((inst: any) => inst.storageUrl || ""),
    [sortedInstances]
  );
  const cellInstances = useMemo(
    () =>
      sortedInstances.map((inst: any) => ({
        id: inst.id,
        storageUrl: inst.storageUrl,
      })),
    [sortedInstances]
  );

  // Étiquettes d'orientation (A/P/L/R) : lues depuis ImageOrientationPatient de
  // la coupe courante. Best-effort + petit délai (l'image est décodée async par
  // le loader). Désactivées hors 2D. Ne bloque jamais le rendu.
  useEffect(() => {
    if (viewMode !== "2d") {
      setOrientLabels(null);
      return;
    }
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // L'image est décodée de façon asynchrone : on re-tente jusqu'à obtenir
    // l'orientation (max ~5 s), puis on s'arrête.
    const tick = async () => {
      if (cancelled) return;
      tries++;
      try {
        const iop = await activeViewerRef.current?.getImageOrientation?.();
        if (cancelled) return;
        if (iop) {
          setOrientLabels(edgeLabelsFromIop(iop));
          return;
        }
      } catch {
        /* pas encore prêt */
      }
      if (tries < 10 && !cancelled) timer = setTimeout(tick, 500);
    };
    timer = setTimeout(tick, 300);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [viewMode, selectedSeries, currentSlice, sortKey, sortAsc]);

  // Les images clés sont propres à une série : on les réinitialise au changement.
  useEffect(() => {
    setKeyImageSlices([]);
  }, [selectedSeries]);

  // Auto-select first series
  useEffect(() => {
    if (seriesList && seriesList.length > 0 && !selectedSeries) {
      setSelectedSeries(seriesList[0].id);
    }
  }, [seriesList, selectedSeries]);

  // Protocole d'accrochage : applique automatiquement la disposition + le preset
  // W/L + l'outil initial selon la modalité / description de la série ouverte
  // (ex. CT thorax → poumon). On l'applique UNE SEULE FOIS par série pour ne pas
  // « combattre » les réglages manuels de l'utilisateur après chargement.
  const appliedProtocolForSeries = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedSeries || !seriesList) return;
    if (appliedProtocolForSeries.current === selectedSeries) return;
    const s = (seriesList as any[]).find(x => x.id === selectedSeries);
    if (!s) return;
    appliedProtocolForSeries.current = selectedSeries;
    const protocol = pickHangingProtocol(
      s.modality || study?.modality,
      s.seriesDescription
    );
    const preset = WL_PRESETS.find(p => p.name === protocol.wlPreset);
    if (preset) {
      setWindowWidth(preset.ww);
      setWindowCenter(preset.wc);
    }
    setViewportLayout(protocol.layout);
    setActiveTool(protocol.initialTool);
  }, [selectedSeries, seriesList, study]);

  // Update total slices when instances change
  useEffect(() => {
    if (instancesList) {
      setTotalSlices(Math.max(1, instancesList.length));
      setCurrentSlice(0);
      setCinePlaying(false); // on arrête le ciné au changement de série
    }
  }, [instancesList]);

  // Bascule lecture/pause du ciné (utilisée par le bouton et la touche Espace).
  const toggleCine = useCallback(() => setCinePlaying(p => !p), []);

  // Change la disposition des viewports et borne la cellule active dans la
  // nouvelle grille (ex. on était sur la cellule 3 en 2x2 puis on repasse 1x1).
  const handleLayoutChange = useCallback((layout: ViewportLayout) => {
    setViewportLayout(layout);
    setActiveCell(prev => clampActiveCell(prev, layout));
  }, []);

  // Ciné : avance automatiquement la coupe courante à la cadence choisie, en
  // boucle. Le timer est nettoyé au démontage et à la pause ; on s'appuie sur la
  // logique pure `nextCineIndex` (testée). Le préchargement Cornerstone reste
  // libre de tourner en parallèle (pas de conflit avec le simple changement
  // d'index). N'avance pas s'il n'y a qu'une seule coupe.
  useEffect(() => {
    if (!cinePlaying || totalSlices <= 1) return;
    const id = window.setInterval(() => {
      setCurrentSlice(prev => nextCineIndex(prev, totalSlices, true));
    }, fpsToIntervalMs(cineFps));
    return () => window.clearInterval(id);
  }, [cinePlaying, cineFps, totalSlices]);

  // Raccourcis clavier globaux (actifs sur la page du visualiseur). Le mapping
  // pur touche → action vit dans `keyboardShortcuts.ts` (testé) ; ici on ne fait
  // qu'appliquer l'effet. On ignore la frappe quand le focus est dans un champ
  // de saisie (input/textarea/contenteditable) pour ne pas gêner la saisie.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      const action = resolveShortcut(e, QUICK_PRESETS.length);
      if (!action) return;
      e.preventDefault();

      switch (action.kind) {
        case "prevSlice":
          setCurrentSlice(prev => Math.max(0, prev - 1));
          break;
        case "nextSlice":
          setCurrentSlice(prev => Math.min(totalSlices - 1, prev + 1));
          break;
        case "firstSlice":
          setCurrentSlice(0);
          break;
        case "lastSlice":
          setCurrentSlice(totalSlices - 1);
          break;
        case "tool":
          setActiveTool(action.tool);
          break;
        case "preset": {
          const preset = QUICK_PRESETS[action.index];
          if (preset) {
            setWindowWidth(preset.ww);
            setWindowCenter(preset.wc);
          }
          break;
        }
        case "cineToggle":
          toggleCine();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [totalSlices, toggleCine]);

  // Persist measurement annotations to the DB. (v1 inserts a new row per save;
  // there is no update endpoint yet — see the risk note in the PR description.)
  const saveAnnotationMutation = trpc.annotations.save.useMutation();
  const handleSaveAnnotation = useCallback(
    (a: { instanceId: number; type: any; data: unknown }) => {
      saveAnnotationMutation.mutate(
        // L'objet annotation Cornerstone est dynamique (typé `any` côté lib) ;
        // le serveur le valide à l'exécution via annotationDataSchema (zod).
        { instanceId: a.instanceId, type: a.type, data: a.data as any },
        {
          onError: err => {
            // Best-effort: a failed save must not interrupt the reading workflow.
            console.warn("[annotations] échec de sauvegarde:", err?.message);
          },
        }
      );
    },
    [saveAnnotationMutation]
  );

  // Re-hydration source: all saved annotations for the current series, fetched
  // in one round-trip. Re-added to the viewport by CornerstoneViewer.
  const { data: savedAnnotations } = trpc.annotations.listBySeries.useQuery(
    { seriesId: selectedSeries! },
    { enabled: !!selectedSeries }
  );

  // ROI tools clear the stats overlay when deselected (it now updates via the
  // ANNOTATION_COMPLETED/MODIFIED events wired in CornerstoneViewer).
  useEffect(() => {
    if (!["ellipse", "rect"].includes(activeTool)) setHuStats(null);
  }, [activeTool]);

  // Handle scroll on viewport for slice navigation
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        setCurrentSlice(prev => Math.min(totalSlices - 1, prev + 1));
      } else {
        setCurrentSlice(prev => Math.max(0, prev - 1));
      }
    },
    [totalSlices]
  );

  // Grab the rendered viewport canvas (the onscreen 2D copy Cornerstone keeps).
  const getViewportCanvas = () =>
    document.querySelector<HTMLCanvasElement>("#cornerstone-viewport canvas");

  // Renvoie le canvas À EXPORTER : si l'image courante porte des caviardages,
  // on recompose une COPIE avec les zones masquées en noir opaque ; sinon le
  // canvas onscreen tel quel. C'est le point unique par lequel passent toutes
  // les sorties (capture / impression / email / compte rendu), garantissant
  // que le PHI brûlé ne quitte jamais le visualiseur en clair.
  const getExportCanvas = (): HTMLCanvasElement | null => {
    const canvas = getViewportCanvas();
    if (!canvas) return null;
    return compositeRedactedCanvas(canvas, currentRedactions) ?? canvas;
  };

  // Grab the current view as PNG base64 WITHOUT the data:image/png;base64, prefix
  // (same mechanism as Email/Capture). Returns null if no canvas is rendered.
  // Les caviardages sont recomposés sur la sortie.
  const captureCurrentPng = (): string | null => {
    const canvas = getExportCanvas();
    if (!canvas) return null;
    return canvas.toDataURL("image/png").split(",")[1] ?? null;
  };

  // Add the current slice as a key image for the report.
  const addKeyImage = () => {
    const b64 = captureCurrentPng();
    if (!b64) {
      toast.error("Aucune image à capturer");
      return;
    }
    setReportKeyImages(prev => [
      ...prev,
      { pngBase64: b64, sliceIndex: currentSlice },
    ]);
    toast.success("Image clé ajoutée au compte rendu");
  };

  // Ouvre le compte rendu : si aucune image clé n'a été ajoutée, capture
  // automatiquement la coupe affichée pour que la pré-analyse IA puisse démarrer
  // toute seule (le panneau lance l'IA automatiquement dans ce cas).
  const openReport = () => {
    if (reportKeyImages.length === 0) {
      const b64 = captureCurrentPng();
      if (b64) {
        setReportKeyImages([{ pngBase64: b64, sliceIndex: currentSlice }]);
      }
    }
    setReportOpen(true);
  };

  // Capture: download the current view as a PNG (caviardages recomposés).
  const handleCapture = useCallback(() => {
    const canvas = getExportCanvas();
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `capture_study${studyId ?? ""}_slice${currentSlice + 1}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId, currentSlice, redactionKey, redactionsByImage]);

  // Export: download the whole study as a ZIP of DICOM files (server route,
  // same-origin so the session cookie authenticates the request).
  const handleExport = useCallback(() => {
    if (!studyId) return;
    window.location.href = `/api/export/dicom-zip/${studyId}`;
  }, [studyId]);

  // Planche d'impression — équivalent web du « DICOM Print » de Horos. On
  // assemble une grille d'images (images-clés capturées + vue courante) dans une
  // fenêtre imprimable, puis on lance l'impression du navigateur (papier ou PDF).
  const handlePrintSheet = useCallback(() => {
    const imgs: string[] = reportKeyImages.map(
      k => `data:image/png;base64,${k.pngBase64}`
    );
    const canvas = getExportCanvas();
    if (canvas) imgs.push(canvas.toDataURL("image/png"));
    if (imgs.length === 0) {
      toast.error("Aucune image à imprimer");
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      toast.error("Fenêtre d'impression bloquée (autoriser les pop-ups)");
      return;
    }
    const cols = imgs.length <= 1 ? 1 : imgs.length <= 4 ? 2 : 3;
    // Échappement HTML : patientName/modality viennent des métadonnées DICOM
    // (texte non fiable) → on neutralise toute injection avant write().
    const esc = (v: unknown) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const title = `${esc(study?.patientName) || "Patient"} — ${esc(study?.modality)}`;
    const date = esc(new Date().toLocaleString("fr-CH"));
    const body = imgs.map(s => `<img src="${s}"/>`).join("");
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Planche — ${title}</title>` +
        `<style>` +
        `*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}` +
        `.hdr{padding:8px 12px;font-size:12px;border-bottom:1px solid #ccc;display:flex;justify-content:space-between}` +
        `.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;padding:6px}` +
        `img{width:100%;display:block;background:#000;border:1px solid #000}` +
        `@media print{@page{margin:8mm}}` +
        `</style></head><body>` +
        `<div class="hdr"><strong>${title}</strong><span>${imgs.length} image(s) · ${date} · MediView</span></div>` +
        `<div class="grid">${body}</div>` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},500)}<\/script>` +
        `</body></html>`
    );
    w.document.close();
  }, [reportKeyImages, study]);

  // Print: open the current view in a print dialog (caviardages recomposés).
  const handlePrint = useCallback(() => {
    const canvas = getExportCanvas();
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const w = window.open("", "_blank");
    if (!w) return;
    const doc = w.document;
    doc.title = "Print";
    doc.body.style.margin = "0";
    doc.body.style.background = "#000";
    const img = doc.createElement("img");
    img.src = dataUrl;
    img.style.cssText =
      "max-width:100%;max-height:100vh;display:block;margin:auto";
    img.onload = () => {
      w.focus();
      w.print();
    };
    doc.body.appendChild(img);
  }, []);

  // Email a PDF report (study info + current image) to a recipient, who can
  // open it directly from their inbox — no login, no link.
  const sendReportMutation = trpc.email.sendReport.useMutation();
  const handleEmailReport = useCallback(async () => {
    // Canvas caviardé : le PHI brûlé est retiré avant l'envoi par email.
    const canvas = getExportCanvas();
    if (!canvas || !studyId) {
      toast.error("Aucune image à envoyer");
      return;
    }
    const to = window.prompt("Adresse email du destinataire :");
    if (!to) return;
    try {
      // Send only the rendered image; the server assembles the PDF from the
      // authoritative study record (prevents arbitrary-attachment relay).
      const imagePngBase64 = canvas.toDataURL("image/png").split(",")[1];
      await sendReportMutation.mutateAsync({ to, studyId, imagePngBase64 });
      toast.success(`Compte rendu PDF envoyé à ${to}`);
    } catch (e: any) {
      toast.error("Échec de l'envoi : " + (e?.message || "erreur"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId, sendReportMutation, redactionKey, redactionsByImage]);

  // Export DICOM des annotations : SR (mesures) et GSPS (calques graphiques).
  // Le serveur construit l'objet Part-10 (dcmjs) à partir des annotations
  // enregistrées de la série ; on télécharge les octets .dcm renvoyés en base64.
  const exportSrMutation = trpc.annotations.exportSr.useMutation();
  const exportGspsMutation = trpc.annotations.exportGsps.useMutation();

  const downloadDicom = (filename: string, dicomBase64: string) => {
    const bytes = Uint8Array.from(atob(dicomBase64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/dicom" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleExportSr = useCallback(async () => {
    if (!selectedSeries) {
      toast.error("Sélectionnez une série");
      return;
    }
    try {
      const res = await exportSrMutation.mutateAsync({
        seriesId: selectedSeries,
      });
      if (!res.success) {
        toast.error(res.error || "Export SR impossible");
        return;
      }
      downloadDicom(res.filename, res.dicomBase64);
      toast.success("Compte rendu structuré (SR) exporté");
    } catch (e: any) {
      toast.error("Échec de l'export SR : " + (e?.message || "erreur"));
    }
  }, [selectedSeries, exportSrMutation]);

  const handleExportGsps = useCallback(async () => {
    if (!selectedSeries) {
      toast.error("Sélectionnez une série");
      return;
    }
    try {
      const res = await exportGspsMutation.mutateAsync({
        seriesId: selectedSeries,
      });
      if (!res.success) {
        toast.error(res.error || "Export GSPS impossible");
        return;
      }
      downloadDicom(res.filename, res.dicomBase64);
      toast.success("État de présentation (GSPS) exporté");
    } catch (e: any) {
      toast.error("Échec de l'export GSPS : " + (e?.message || "erreur"));
    }
  }, [selectedSeries, exportGspsMutation]);

  // Export du volume 3D chargé en maillage de surface Wavefront .OBJ.
  // Pipeline : volume Cornerstone (vtkImageData) → marching cubes VTK.js
  // (isosurface au seuil HU) → sérialisation OBJ pure → téléchargement.
  // Disponible UNIQUEMENT en mode 3D (le volume y est forcément chargé).
  // Lourd (plusieurs secondes, peut figer brièvement l'onglet) → état de
  // chargement + yield au navigateur avant l'extraction. Tout est encadré par
  // try/catch : un échec ne doit jamais casser le visualiseur.
  const handleExport3d = useCallback(async () => {
    if (meshExporting) return;
    setMeshExporting(true);
    try {
      const cornerstone = await import("@cornerstonejs/core");
      // Même volumeId que VolumeViewer (aucun volumeId/orthancImageIds passé ici
      // → valeur locale par défaut).
      const volId = "cornerstoneStreamingImageVolume:HOROS_VOL";
      const volume = (cornerstone as any).cache?.getVolume?.(volId);
      if (!volume) {
        toast.error("Volume non chargé");
        return;
      }
      // Cornerstone v4 : les voxels sont gérés par un voxelManager et NE sont PAS
      // posés sur le PointData du vtkImageData (marching cubes recevait des
      // scalaires null). De plus le volume streaming est « image-based » (par
      // coupe) : getScalarData() LÈVE « No scalar data available » ; c'est
      // getCompleteScalarDataArray() qui assemble les coupes en un tableau
      // contigu. On essaie les méthodes dans cet ordre, chacune pouvant lever.
      const vm = volume.voxelManager;
      let scalars: ArrayLike<number> | undefined;
      for (const getter of [
        () => vm?.getCompleteScalarDataArray?.(),
        () => vm?.getScalarData?.(),
        () => volume.getScalarData?.(),
      ]) {
        try {
          const s = getter();
          if (s && (s as any).length > 0) {
            scalars = s;
            break;
          }
        } catch {
          /* indisponible pour ce type de volume → méthode suivante */
        }
      }
      if (!scalars) {
        toast.error(
          "Données du volume indisponibles (réessayez après chargement)"
        );
        return;
      }

      // Laisse le spinner se peindre avant l'appel bloquant (pas de web worker).
      await new Promise(r => setTimeout(r, 0));

      const [
        { default: vtkImageMarchingCubes },
        { default: vtkImageData },
        { default: vtkDataArray },
      ] = await Promise.all([
        import("@kitware/vtk.js/Filters/General/ImageMarchingCubes"),
        import("@kitware/vtk.js/Common/DataModel/ImageData"),
        import("@kitware/vtk.js/Common/Core/DataArray"),
      ]);

      // Dimensions/spacing/origin PLEINE résolution : servent à la couleur
      // (échantillonnage HU fidèle), conservés intacts.
      const fullDims = volume.dimensions as [number, number, number];
      const fullSpacing = volume.spacing as [number, number, number];
      const fullOrigin = volume.origin as [number, number, number];

      // Sous-échantillonnage du volume pour des marching cubes plus légers
      // (vtk.js 34.x n'a pas de décimation de maillage → on réduit en amont).
      // La GÉOMÉTRIE devient plus grossière, mais la COULEUR reste échantillonnée
      // sur le volume PLEINE résolution (voir plus bas).
      const ds = downsampleScalarVolume(
        scalars,
        fullDims,
        fullSpacing,
        fullOrigin,
        meshFactor
      );

      const imageData = vtkImageData.newInstance();
      imageData.setDimensions(ds.dims);
      imageData.setSpacing(ds.spacing);
      imageData.setOrigin(ds.origin);
      // Après sous-échantillonnage par stride, la grille reste alignée sur les
      // axes monde ; on ne réapplique pas la matrice de direction (identité).
      if (meshFactor === 1 && volume.direction)
        imageData.setDirection(volume.direction);
      imageData.getPointData().setScalars(
        vtkDataArray.newInstance({
          name: "scalars",
          numberOfComponents: 1,
          values: ds.scalars,
        })
      );

      const filter = vtkImageMarchingCubes.newInstance({
        contourValue: meshThreshold,
        // Normales activées : l'OBJ exporté (vn + f v//vn) s'ombre correctement
        // dans MeshLab/Blender. Sert aussi à échantillonner la densité interne.
        computeNormals: true,
        mergePoints: true,
      });
      filter.setInputData(imageData);
      filter.update();
      const polydata = filter.getOutputData();

      let points: Float32Array =
        polydata?.getPoints?.()?.getData?.() ?? new Float32Array();
      const polys: Int32Array =
        polydata?.getPolys?.()?.getData?.() ?? new Int32Array();
      // Normales (peuvent être absentes selon la version → repli gracieux).
      let normals: Float32Array | undefined;
      try {
        const nd = polydata?.getPointData?.()?.getNormals?.()?.getData?.();
        if (nd && nd.length === points.length) normals = nd as Float32Array;
      } catch {
        /* pas de normales → on exporte sans `vn` */
      }

      // Lissage de Taubin optionnel : on déplace les sommets (sans rétrécir le
      // volume) puis on RECALCULE les normales — les normales des marching cubes
      // ne sont plus valides après déplacement. La couleur est échantillonnée
      // plus bas sur les positions FINALES (lissées), donc cohérente.
      if (meshSmoothing && points.length > 0 && polys.length > 0) {
        const adjacency = buildVertexAdjacency(
          polys,
          Math.floor(points.length / 3)
        );
        points = taubinSmooth(points, adjacency, { iterations: 10 });
        normals = computeVertexNormals(points, polys);
      }

      const stats = polyDataArraysStats(points, polys);
      if (stats.triangleCount === 0) {
        toast.error(
          `Aucune surface au seuil ${meshThreshold} HU — ajustez la valeur`
        );
        return;
      }

      // ── Couleur par sommet selon la DENSITÉ RÉELLE (HU) ─────────────────────
      // Pour chaque sommet du maillage : on convertit sa position monde (mm) en
      // index de voxel (worldToIndex, hypothèse axis-aligned), on échantillonne
      // le HU réel par interpolation trilinéaire, puis on mappe HU→gris via une
      // fenêtre osseuse (WC 500 / WW 2000). Comme l'isosurface est ~uniforme au
      // seuil, on échantillonne un PETIT PAS VERS L'INTÉRIEUR du matériau (le
      // long de la normale inverse) : la couleur porte alors la texture de
      // densité interne (cortical dense vs spongieux) plutôt qu'une teinte plate.
      //
      // LIMITATION : worldToIndex suppose une direction de volume identité/axis-
      // aligned. Si volume.direction n'est pas l'identité (acquisition oblique),
      // l'échantillonnage serait décalé. On le détecte et, le cas échéant, on
      // n'échantillonne pas vers l'intérieur (pas = 0) pour rester sûr.
      // COULEUR fidèle : on échantillonne TOUJOURS sur le volume PLEINE
      // résolution (full*), pas sur le volume sous-échantillonné, pour garder la
      // texture de densité même quand la géométrie est grossière.
      const WC_BONE = 500;
      const WW_BONE = 2000;
      const dims = fullDims;
      const spacing = fullSpacing;
      const origin = fullOrigin;
      // Détection direction non-axis-aligned (hors diagonale ±1).
      const dir = volume.direction as number[] | undefined;
      const isAxisAligned =
        !dir ||
        (dir.length === 9 &&
          [dir[1], dir[2], dir[3], dir[5], dir[6], dir[7]].every(
            v => Math.abs(v) < 1e-6
          ));
      // Pas vers l'intérieur (mm) le long de -normale, ~1 voxel min.
      const minSp = Math.min(spacing[0], spacing[1], spacing[2]) || 1;
      const inwardStep = normals && isAxisAligned ? minSp : 0;

      const vCount = Math.floor(points.length / 3);
      const colors = new Float32Array(vCount * 3);
      for (let v = 0; v < vCount; v++) {
        let px = points[v * 3];
        let py = points[v * 3 + 1];
        let pz = points[v * 3 + 2];
        if (inwardStep && normals) {
          // Décalage vers l'intérieur (matériau) le long de -normale.
          px -= normals[v * 3] * inwardStep;
          py -= normals[v * 3 + 1] * inwardStep;
          pz -= normals[v * 3 + 2] * inwardStep;
        }
        const [ix, iy, iz] = worldToIndex([px, py, pz], origin, spacing);
        const hu = sampleVolumeTrilinear(scalars, dims, ix, iy, iz);
        const [r, g, b] = huToRgb(hu, WC_BONE, WW_BONE);
        colors[v * 3] = r;
        colors[v * 3 + 1] = g;
        colors[v * 3 + 2] = b;
      }

      // Sérialisation selon le format choisi : PLY binaire, OBJ texte ou GLB.
      const ext = meshFormat;
      let blob: Blob;
      if (meshFormat === "glb") {
        // glTF binaire : indices triangulés explicites + COLOR_0 RGB.
        const indices = polysToTriangleIndices(polys);
        blob = meshToGlb({ points, indices, normals, colors });
      } else if (meshFormat === "ply") {
        blob = meshToBinaryPly({ points, polys, colors, normals });
      } else {
        blob = new Blob(
          [polyDataArraysToObj(points, polys, { colors, normals })],
          { type: "text/plain" }
        );
      }

      const safeName = (study?.patientName || `study${studyId ?? ""}`)
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 60);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mediview-3d-${safeName || "volume"}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);

      const sizeMb = blob.size / (1024 * 1024);
      const sizeStr =
        sizeMb >= 1
          ? `${sizeMb.toLocaleString("fr-CH", { maximumFractionDigits: 1 })} Mo`
          : `${Math.max(1, Math.round(blob.size / 1024)).toLocaleString(
              "fr-CH"
            )} Ko`;
      toast.success(
        `Maillage exporté (${ext.toUpperCase()}) : ${stats.triangleCount.toLocaleString(
          "fr-CH"
        )} triangles, ${sizeStr}`
      );
    } catch (e: any) {
      console.error("[ExportOBJ] échec:", e);
      toast.error("Échec de l'export 3D : " + (e?.message || "erreur"));
    } finally {
      setMeshExporting(false);
    }
  }, [
    meshExporting,
    meshThreshold,
    meshFactor,
    meshFormat,
    meshSmoothing,
    study,
    studyId,
  ]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      {/* Barre d'outils : `flex-wrap` + hauteur mini pour que TOUS les boutons
          restent visibles (sinon, avec ~48 boutons, les derniers — dont
          « Compte rendu »/« Email » — débordaient hors écran et étaient coupés). */}
      <div className="min-h-12 border-b border-border bg-card flex flex-wrap items-center px-2 gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/")}
          className="gap-1 text-xs"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>

        <Separator orientation="vertical" className="h-7 mx-1" />

        {/* Viewer Tools */}
        {VIEWER_TOOLS.map(tool => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`toolbar-btn ${activeTool === tool.id ? "active" : ""}`}
            title={tool.description}
          >
            <tool.icon className="w-4 h-4" />
            <span className="text-[9px]">{tool.label}</span>
          </button>
        ))}

        {/* Groupe « Image » façon Horos (2D) : CLUT, négatif, rotation, miroir,
            reset. Regroupé dans un menu déroulant pour ne pas surcharger la barre. */}
        {viewMode === "2d" && (
          <>
            <Separator orientation="vertical" className="h-7 mx-1" />
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="toolbar-btn"
                  title="Image : CLUT, négatif, rotation, miroir"
                >
                  <Palette className="w-4 h-4" />
                  <span className="text-[9px]">Image</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-60 space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Palette couleur (CLUT)
                  </label>
                  <select
                    className="w-full text-xs bg-input border border-border rounded px-2 py-1"
                    value={activeColormap ?? ""}
                    onChange={e => {
                      const name = e.target.value || null;
                      setActiveColormap(name);
                      activeViewerRef.current?.setColormap(name);
                    }}
                  >
                    <option value="">No CLUT (niveaux de gris)</option>
                    {COLORMAPS.map(c => (
                      <option key={c.name} value={c.name}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Tri des coupes (Sort By)
                  </label>
                  <div className="flex gap-1.5">
                    <select
                      className="flex-1 text-xs bg-input border border-border rounded px-2 py-1"
                      value={sortKey}
                      onChange={e =>
                        setSortKey(
                          e.target.value as "instanceNumber" | "sliceLocation"
                        )
                      }
                    >
                      <option value="instanceNumber">Numéro d'instance</option>
                      <option value="sliceLocation">Position de coupe</option>
                    </select>
                    <button
                      className="toolbar-btn !flex-row gap-1 border border-border px-2"
                      title={sortAsc ? "Croissant" : "Décroissant"}
                      onClick={() => setSortAsc(a => !a)}
                    >
                      <span className="text-[10px]">{sortAsc ? "↑" : "↓"}</span>
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Fonction VOI LUT
                  </label>
                  <div className="flex gap-1.5">
                    {(["LINEAR", "SIGMOID"] as const).map(fn => (
                      <button
                        key={fn}
                        className={`toolbar-btn !flex-row flex-1 gap-1 border border-border ${voiLutFn === fn ? "active" : ""}`}
                        onClick={() => {
                          setVoiLutFn(fn);
                          activeViewerRef.current?.setVoiLutFunction(fn);
                        }}
                      >
                        <span className="text-[10px]">
                          {fn === "LINEAR" ? "Linéaire" : "Sigmoïde"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    Fenêtre W/L (selon modalité)
                  </label>
                  <select
                    className="w-full text-xs bg-input border border-border rounded px-2 py-1"
                    defaultValue=""
                    onChange={e => {
                      const presets = getPresetsForModality(study?.modality);
                      const p = presets.find(x => x.id === e.target.value);
                      if (p && p.wc != null && p.ww != null) {
                        activeViewerRef.current?.setVoi(p.wc, p.ww);
                      }
                    }}
                  >
                    <option value="">Choisir un preset…</option>
                    {getPresetsForModality(study?.modality)
                      .filter(p => p.wc != null && p.ww != null)
                      .map(p => (
                        <option key={p.id} value={p.id}>
                          {p.label} ({p.wc}/{p.ww})
                        </option>
                      ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    className={`toolbar-btn !flex-row gap-1.5 border border-border ${imageInverted ? "active" : ""}`}
                    title="Négatif (inverser)"
                    onClick={() => {
                      const next = !imageInverted;
                      setImageInverted(next);
                      activeViewerRef.current?.setInvert(next);
                    }}
                  >
                    <Contrast className="w-4 h-4" />
                    <span className="text-[10px]">Négatif</span>
                  </button>
                  <button
                    className="toolbar-btn !flex-row gap-1.5 border border-border"
                    title="Rotation 90°"
                    onClick={() => {
                      const deg = (imageRotation + 90) % 360;
                      setImageRotation(deg);
                      activeViewerRef.current?.setRotation(deg);
                    }}
                  >
                    <RotateCw className="w-4 h-4" />
                    <span className="text-[10px]">Rotation 90°</span>
                  </button>
                  <button
                    className="toolbar-btn !flex-row gap-1.5 border border-border"
                    title="Miroir horizontal"
                    onClick={() => activeViewerRef.current?.flip("h")}
                  >
                    <FlipHorizontal className="w-4 h-4" />
                    <span className="text-[10px]">Miroir H</span>
                  </button>
                  <button
                    className="toolbar-btn !flex-row gap-1.5 border border-border"
                    title="Miroir vertical"
                    onClick={() => activeViewerRef.current?.flip("v")}
                  >
                    <FlipVertical className="w-4 h-4" />
                    <span className="text-[10px]">Miroir V</span>
                  </button>
                </div>
                <button
                  className="toolbar-btn !flex-row gap-1.5 border border-border w-full"
                  title="Réinitialiser la vue (Reset Image View)"
                  onClick={() => {
                    setImageRotation(0);
                    setActiveColormap(null);
                    setImageInverted(false);
                    activeViewerRef.current?.resetView();
                  }}
                >
                  <Maximize className="w-4 h-4" />
                  <span className="text-[10px]">Réinitialiser la vue</span>
                </button>
              </PopoverContent>
            </Popover>
            <button
              className="toolbar-btn"
              title="Méta-données DICOM (tags)"
              onClick={openTagInspector}
            >
              <FileText className="w-4 h-4" />
              <span className="text-[9px]">Tags</span>
            </button>
            <button
              className="toolbar-btn"
              title="Planche d'impression (équivalent DICOM Print)"
              onClick={handlePrintSheet}
            >
              <Printer className="w-4 h-4" />
              <span className="text-[9px]">Planche</span>
            </button>
            <button
              className={`toolbar-btn ${keyImageSlices.includes(currentSlice) ? "active" : ""}`}
              title="Marquer/démarquer l'image clé (Key Image)"
              onClick={() =>
                setKeyImageSlices(prev => toggleKeyImage(prev, currentSlice))
              }
            >
              <Star
                className="w-4 h-4"
                fill={
                  keyImageSlices.includes(currentSlice)
                    ? "currentColor"
                    : "none"
                }
              />
              <span className="text-[9px]">
                Clé{keyImageSlices.length ? ` (${keyImageSlices.length})` : ""}
              </span>
            </button>
            {keyImageSlices.length > 0 && (
              <>
                <button
                  className="toolbar-btn"
                  title="Image clé précédente"
                  onClick={() =>
                    setCurrentSlice(prevKeyImage(keyImageSlices, currentSlice))
                  }
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="text-[9px]">‹ Clé</span>
                </button>
                <button
                  className="toolbar-btn"
                  title="Image clé suivante"
                  onClick={() =>
                    setCurrentSlice(nextKeyImage(keyImageSlices, currentSlice))
                  }
                >
                  <ChevronRight className="w-4 h-4" />
                  <span className="text-[9px]">Clé ›</span>
                </button>
              </>
            )}
            {priors.length > 0 && (
              <button
                className="toolbar-btn"
                title="Antériorités du même patient"
                onClick={() => setPriorsOpen(true)}
              >
                <Layers className="w-4 h-4" />
                <span className="text-[9px]">Antér. ({priors.length})</span>
              </button>
            )}
          </>
        )}

        <Separator orientation="vertical" className="h-7 mx-1" />

        {/* View Mode */}
        <button
          onClick={() => setViewMode("2d")}
          className={`toolbar-btn ${viewMode === "2d" ? "active" : ""}`}
          title="2D Stack View"
        >
          <Maximize className="w-4 h-4" />
          <span className="text-[9px]">2D</span>
        </button>
        <button
          onClick={() => setViewMode("mpr")}
          className={`toolbar-btn ${viewMode === "mpr" ? "active" : ""}`}
          title="MPR Reconstruction"
        >
          <Crosshair className="w-4 h-4" />
          <span className="text-[9px]">MPR</span>
        </button>
        <button
          onClick={() => setViewMode("3d")}
          className={`toolbar-btn ${viewMode === "3d" ? "active" : ""}`}
          title="3D Volume Rendering"
        >
          <Grid3X3 className="w-4 h-4" />
          <span className="text-[9px]">3D</span>
        </button>

        {/* Disposition des viewports (mosaïque) — 2D uniquement */}
        {viewMode === "2d" && (
          <>
            <Separator orientation="vertical" className="h-7 mx-1" />
            <button
              onClick={() => handleLayoutChange("1x1")}
              className={`toolbar-btn ${viewportLayout === "1x1" ? "active" : ""}`}
              title="Affichage simple (1×1)"
            >
              <Square className="w-4 h-4" />
              <span className="text-[9px]">1×1</span>
            </button>
            <button
              onClick={() => handleLayoutChange("1x2")}
              className={`toolbar-btn ${viewportLayout === "1x2" ? "active" : ""}`}
              title="Deux viewports côte à côte (1×2)"
            >
              <Columns2 className="w-4 h-4" />
              <span className="text-[9px]">1×2</span>
            </button>
            <button
              onClick={() => handleLayoutChange("2x2")}
              className={`toolbar-btn ${viewportLayout === "2x2" ? "active" : ""}`}
              title="Mosaïque de quatre viewports (2×2)"
            >
              <Grid2x2 className="w-4 h-4" />
              <span className="text-[9px]">2×2</span>
            </button>
          </>
        )}

        {/* Slab controls — MPR only */}
        {viewMode === "mpr" && (
          <div className="flex items-center gap-2 px-2">
            <label className="text-[10px] text-muted-foreground">Slab</label>
            <input
              type="range"
              min={0}
              max={50}
              step={1}
              value={slabThicknessMm}
              onChange={e => setSlabThicknessMm(Number(e.target.value))}
              title="Épaisseur de coupe (mm)"
            />
            <span className="text-[10px] w-8">{slabThicknessMm}mm</span>
            <select
              className="bg-transparent text-[10px] border border-border rounded"
              value={slabMode}
              onChange={e => setSlabMode(e.target.value as SlabMode)}
            >
              {SLAB_MODES.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            <Separator orientation="vertical" className="h-7 mx-1" />

            {/* Fusion PET-CT — MPR uniquement. Fonctionnel si l'étude contient
                une série PET (modality PT) ; sinon désactivé avec un message
                explicite. La superposition est additive et fail-safe : un échec
                de chargement PET laisse le MPR CT intact. */}
            <label
              className="text-[10px] text-muted-foreground"
              title="Superposer une série PET colorée sur le CT (fusion)"
            >
              Fusion PET
            </label>
            {hasPet ? (
              <>
                <select
                  className="bg-transparent text-[10px] border border-border rounded"
                  value={fusionPetSeries ?? ""}
                  onChange={e =>
                    setFusionPetSeries(
                      e.target.value ? Number(e.target.value) : null
                    )
                  }
                  title="Choisir la série PET à fusionner"
                >
                  <option value="">Désactivée</option>
                  {petSeriesOptions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.seriesDescription ||
                        `Série PET ${s.seriesNumber ?? s.id}`}
                    </option>
                  ))}
                </select>
                {fusionPetSeries && (
                  <>
                    <select
                      className="bg-transparent text-[10px] border border-border rounded"
                      value={petColormapId}
                      onChange={e => setPetColormapId(e.target.value)}
                      title="Palette de couleurs PET"
                    >
                      {PET_COLORMAPS.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(fusionOpacity * 100)}
                      onChange={e =>
                        setFusionOpacity(Number(e.target.value) / 100)
                      }
                      title="Opacité de la fusion PET (%)"
                    />
                    <span className="text-[10px] w-8">
                      {Math.round(fusionOpacity * 100)}%
                    </span>
                    {/* Facteur SUV (body weight) issu des métadonnées PET. */}
                    {fusionActive && (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={
                          suvResult?.factor != null
                            ? `SUV = valeur_pixel × ${suvResult.factor.toExponential(
                                3
                              )} (décroissance ${suvResult.decayTimeSec ?? "?"} s)`
                            : suvResult?.reason ||
                              "Facteur SUV en cours de calcul…"
                        }
                      >
                        {suvResult?.factor != null
                          ? `SUV ×${suvResult.factor.toExponential(2)}`
                          : "SUV n/d"}
                      </span>
                    )}
                  </>
                )}
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground/60 italic">
                Aucune série PET dans cette étude
              </span>
            )}

            <Separator orientation="vertical" className="h-7 mx-1" />

            {/* Curved MPR (bêta) — ouvre un panneau autonome de reformation
                curviligne. N'altère pas les viewports MPR. */}
            <button
              className="toolbar-btn"
              title="Curved MPR (bêta) — reformation curviligne le long d'une courbe"
              onClick={() => setCurvedMprOpen(true)}
            >
              <Spline className="w-4 h-4" />
              <span className="text-[9px]">Curved MPR (bêta)</span>
            </button>
          </div>
        )}
        {/* Presets de rendu volumique — 3D only (liste déroulante : trop de
            presets pour des boutons). Rotation à la souris (bouton gauche),
            zoom molette/clic droit, pan clic du milieu. */}
        {viewMode === "3d" && (
          <div className="flex items-center gap-2 px-2">
            <label className="text-[10px] text-muted-foreground">Preset</label>
            <select
              className="bg-transparent text-[10px] border border-border rounded"
              value={preset3d}
              onChange={e => setPreset3d(e.target.value)}
              title="Rendu volumique 3D — choisir un preset"
            >
              {PRESETS_3D.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span
              className="text-[9px] text-muted-foreground"
              title="Faire tourner : glisser (bouton gauche) · Zoom : molette/clic droit · Déplacer : clic du milieu"
            >
              ↺ glisser pour tourner
            </span>
            <Separator orientation="vertical" className="h-7 mx-1" />
            {/* Toggle « Rendu réaliste » (éclairage cinématique + qualité accrue).
                ON par défaut ; à couper si trop lent sur la machine. */}
            <label
              className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none"
              title="Éclairage volumétrique cinématique + échantillonnage haute qualité (plus réaliste mais plus lourd pour le GPU)"
            >
              <input
                type="checkbox"
                checked={realistic3d}
                onChange={e => setRealistic3d(e.target.checked)}
                className="accent-primary"
              />
              Rendu réaliste
            </label>
            <Separator orientation="vertical" className="h-7 mx-1" />
            {/* Export maillage 3D (.obj) : isosurface (marching cubes) au seuil
                HU choisi. ~300 HU = os. Opération lourde → bouton désactivé +
                « Génération… » pendant le calcul. */}
            <label
              className="text-[10px] text-muted-foreground"
              title="Seuil HU de l'isosurface (≈300 = os)"
            >
              Seuil
            </label>
            <input
              type="number"
              step={50}
              value={meshThreshold}
              onChange={e => setMeshThreshold(Number(e.target.value))}
              className="w-16 bg-transparent text-[10px] border border-border rounded px-1 py-0.5"
              title="Seuil HU de l'isosurface (≈300 = os)"
              disabled={meshExporting}
            />
            {/* Résolution du maillage : facteur de sous-échantillonnage du
                volume (vtk.js 34.x sans décimation → on réduit en amont). */}
            <label
              className="text-[10px] text-muted-foreground"
              title="Résolution du maillage : plus basse = fichier plus léger"
            >
              Résolution
            </label>
            <select
              value={meshFactor}
              onChange={e => setMeshFactor(Number(e.target.value))}
              className="bg-transparent text-[10px] border border-border rounded px-1 py-0.5"
              title="Résolution du maillage 3D exporté"
              disabled={meshExporting}
            >
              <option value={1}>Pleine</option>
              <option value={2}>Moyenne (½)</option>
              <option value={4}>Basse (¼)</option>
            </select>
            {/* Format : PLY binaire (compact, défaut) ou OBJ texte. */}
            <label
              className="text-[10px] text-muted-foreground"
              title="Format du fichier 3D exporté"
            >
              Format
            </label>
            <select
              value={meshFormat}
              onChange={e =>
                setMeshFormat(e.target.value as "ply" | "obj" | "glb")
              }
              className="bg-transparent text-[10px] border border-border rounded px-1 py-0.5"
              title="Format du fichier 3D exporté"
              disabled={meshExporting}
            >
              <option value="ply">PLY (binaire, compact)</option>
              <option value="obj">OBJ (texte)</option>
              <option value="glb">GLB (glTF binaire)</option>
            </select>
            {/* Lissage de Taubin : atténue l'aliasing en escalier sans rétrécir
                le volume (normales recalculées après lissage). */}
            <label
              className="text-[10px] text-muted-foreground flex items-center gap-1"
              title="Lissage de Taubin du maillage (atténue l'effet escalier)"
            >
              <input
                type="checkbox"
                checked={meshSmoothing}
                onChange={e => setMeshSmoothing(e.target.checked)}
                disabled={meshExporting}
              />
              Lissage
            </label>
            <button
              className="toolbar-btn"
              title="Extraire une isosurface et télécharger un maillage 3D (PLY binaire ou OBJ texte)"
              onClick={handleExport3d}
              disabled={meshExporting}
            >
              <Box className="w-4 h-4" />
              <span className="text-[9px]">
                {meshExporting ? "Génération…" : "Exporter 3D"}
              </span>
            </button>
          </div>
        )}
        <Separator orientation="vertical" className="h-7 mx-1" />

        {/* Image manipulation */}
        <button className="toolbar-btn" title="Flip Horizontal">
          <FlipHorizontal className="w-4 h-4" />
          <span className="text-[9px]">Flip H</span>
        </button>
        <button className="toolbar-btn" title="Flip Vertical">
          <FlipVertical className="w-4 h-4" />
          <span className="text-[9px]">Flip V</span>
        </button>
        <button className="toolbar-btn" title="Rotate">
          <RotateCw className="w-4 h-4" />
          <span className="text-[9px]">Rotate</span>
        </button>

        <div className="flex-1" />

        {/* Export actions */}
        <button
          className="toolbar-btn"
          title="Screenshot (PNG)"
          onClick={handleCapture}
        >
          <Camera className="w-4 h-4" />
          <span className="text-[9px]">Capture</span>
        </button>
        <button
          className="toolbar-btn"
          title="Export study (DICOM ZIP)"
          onClick={handleExport}
        >
          <Download className="w-4 h-4" />
          <span className="text-[9px]">Export</span>
        </button>
        <button
          className="toolbar-btn"
          title="Print current view"
          onClick={handlePrint}
        >
          <Printer className="w-4 h-4" />
          <span className="text-[9px]">Print</span>
        </button>
        <button
          className="toolbar-btn"
          title="Email PDF report to a recipient"
          onClick={handleEmailReport}
          disabled={sendReportMutation.isPending}
        >
          <Mail className="w-4 h-4" />
          <span className="text-[9px]">
            {sendReportMutation.isPending ? "…" : "Email"}
          </span>
        </button>
        <button
          className="toolbar-btn"
          title="Ajouter la coupe courante au compte rendu"
          onClick={addKeyImage}
        >
          <ImagePlus className="w-4 h-4" />
          <span className="text-[9px]">Ajouter l'image</span>
        </button>
        {/* Action principale : bouton coloré pour qu'il soit repérable
            immédiatement, même si la barre passe sur 2 rangées. */}
        <button
          className="toolbar-btn toolbar-btn-cr"
          title="Compte rendu + pré-analyse IA (envoi à un confrère)"
          onClick={openReport}
        >
          <FileText className="w-4 h-4" />
          <span className="text-[9px] font-semibold">Compte rendu</span>
        </button>
        <button
          className="toolbar-btn"
          title="Exporter les mesures en DICOM SR (compte rendu structuré)"
          onClick={handleExportSr}
          disabled={exportSrMutation.isPending || !selectedSeries}
        >
          <FileText className="w-4 h-4" />
          <span className="text-[9px]">
            {exportSrMutation.isPending ? "…" : "Exporter SR"}
          </span>
        </button>
        <button
          className="toolbar-btn"
          title="Exporter les annotations en DICOM GSPS (état de présentation)"
          onClick={handleExportGsps}
          disabled={exportGspsMutation.isPending || !selectedSeries}
        >
          <Layers className="w-4 h-4" />
          <span className="text-[9px]">
            {exportGspsMutation.isPending ? "…" : "Exporter GSPS"}
          </span>
        </button>
        <button
          className="toolbar-btn"
          title="Raccourcis clavier"
          onClick={() => setShortcutsOpen(true)}
        >
          <Keyboard className="w-4 h-4" />
          <span className="text-[9px]">Raccourcis</span>
        </button>
      </div>

      {/* Aide — légende des raccourcis clavier */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Raccourcis clavier</DialogTitle>
            <DialogDescription>
              Actifs sur le visualiseur (hors champs de saisie).
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {shortcutLegend(QUICK_PRESETS.length).map(s => (
              <div key={s.keys} className="contents">
                <kbd className="font-mono text-muted-foreground whitespace-nowrap">
                  {s.keys}
                </kbd>
                <span className="text-foreground">{s.label}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Inspecteur de méta-données DICOM (« DICOM Meta-Data / ⌘I » de Horos) */}
      <Dialog open={tagInspectorOpen} onOpenChange={setTagInspectorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Méta-données DICOM</DialogTitle>
            <DialogDescription>
              Tags de l'image courante ({dicomTags.length}).
            </DialogDescription>
          </DialogHeader>
          <input
            type="text"
            value={tagQuery}
            onChange={e => setTagQuery(e.target.value)}
            placeholder="Filtrer par tag, nom ou valeur…"
            className="w-full text-xs bg-input border border-border rounded px-2 py-1.5"
          />
          <div className="max-h-[60vh] overflow-auto border border-border rounded">
            {tagsLoading ? (
              <p className="text-xs text-muted-foreground p-3">Chargement…</p>
            ) : dicomTags.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">
                Aucun tag (image non décodée ou format non lisible).
              </p>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1 font-medium">Tag</th>
                    <th className="px-2 py-1 font-medium">Nom</th>
                    <th className="px-2 py-1 font-medium">VR</th>
                    <th className="px-2 py-1 font-medium">Valeur</th>
                  </tr>
                </thead>
                <tbody>
                  {dicomTags
                    .filter(t => {
                      const q = tagQuery.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        t.tag.toLowerCase().includes(q) ||
                        t.name.toLowerCase().includes(q) ||
                        t.value.toLowerCase().includes(q)
                      );
                    })
                    .map(t => (
                      <tr
                        key={t.tag}
                        className="border-t border-border/50 hover:bg-accent/40"
                      >
                        <td className="px-2 py-1 whitespace-nowrap text-primary">
                          {t.tag}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {t.name}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {t.vr}
                        </td>
                        <td className="px-2 py-1 break-all">{t.value}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Antériorités / comparatif : études antérieures du même patient */}
      <Dialog open={priorsOpen} onOpenChange={setPriorsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Antériorités du patient</DialogTitle>
            <DialogDescription>
              {study?.patientName || "Patient"} — {priors.length} étude(s)
              antérieure(s).
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto divide-y divide-border/40">
            {priors.map((p: any) => (
              <div key={p.id} className="flex items-center gap-2 py-2 text-xs">
                <div className="flex-1">
                  <div className="font-medium">
                    {p.studyDescription || p.modality || "Étude"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {p.modality || "?"} · {p.studyDate || "date ?"} ·{" "}
                    {p.numberOfImages || p.imageCount || "?"} img
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setPriorsOpen(false);
                    navigate(`/viewer/${p.id}`);
                  }}
                >
                  Ouvrir
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Series Thumbnails */}
        <div className="w-48 border-r border-border bg-sidebar flex flex-col shrink-0">
          <div className="p-2 border-b border-border">
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Series ({seriesList?.length || 0})
            </h3>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-2">
              {seriesList?.map((s: any) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSeries(s.id)}
                  className={`w-full rounded border p-2 text-left transition-colors ${
                    selectedSeries === s.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  {/* Vignette réelle (coupe représentative rendue hors écran),
                      avec repli sur le placeholder noir tant qu'elle n'est pas
                      prête ou si la série n'est pas chargeable. */}
                  <SeriesThumbnail
                    seriesId={s.id}
                    windowWidth={windowWidth}
                    windowCenter={windowCenter}
                  />
                  <div className="text-[10px] text-foreground truncate">
                    {s.seriesDescription || `Series ${s.seriesNumber || s.id}`}
                  </div>
                  <div className="text-[9px] text-muted-foreground flex items-center gap-1">
                    <Badge variant="secondary" className="text-[8px] px-1 py-0">
                      {s.modality || "?"}
                    </Badge>
                    <span>{s.numberOfInstances || 0} img</span>
                  </div>
                </button>
              ))}
              {(!seriesList || seriesList.length === 0) && (
                <div className="text-center py-8">
                  <Layers className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
                  <p className="text-[10px] text-muted-foreground">
                    No series available
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Viewport Area */}
        <div className="flex-1 flex flex-col">
          {/* Viewport */}
          <div
            ref={viewportRef}
            className="flex-1 relative bg-black"
            onWheel={handleWheel}
          >
            {/* DICOM Viewport - Cornerstone3D */}
            {/* En 1x1 et en MPR/3D, l'id `cornerstone-viewport` reste sur ce
                conteneur (capture/print/email/compte rendu inchangés). En
                mosaïque 2D, l'id est déplacé sur la CELLULE ACTIVE (plus bas)
                pour que la capture suive le viewport piloté. */}
            <div
              className="absolute inset-0 dicom-viewport"
              id={
                viewMode === "2d" && viewportLayout !== "1x1"
                  ? undefined
                  : "cornerstone-viewport"
              }
            >
              {!instancesList || instancesList.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Layers className="w-16 h-16 text-muted-foreground/20 mx-auto mb-4" />
                    <p className="text-sm text-muted-foreground">
                      {studyId
                        ? "Select a series to view"
                        : "No study selected"}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      Double-click a study from the main list to open it
                    </p>
                  </div>
                </div>
              ) : viewMode === "2d" ? (
                viewportLayout === "1x1" ? (
                  // 1x1 : rendu STRICTEMENT identique à l'historique — un seul
                  // CornerstoneViewer, sans instanceKey (ids historiques),
                  // remplissant le conteneur #cornerstone-viewport.
                  <CornerstoneViewer
                    ref={activeViewerRef}
                    imageUrls={cellImageUrls}
                    currentSlice={currentSlice}
                    onSliceChange={setCurrentSlice}
                    activeTool={activeTool}
                    windowWidth={windowWidth}
                    windowCenter={windowCenter}
                    onWindowLevelChange={(ww, wc) => {
                      setWindowWidth(ww);
                      setWindowCenter(wc);
                    }}
                    onZoomChange={setZoomPercent}
                    instances={cellInstances}
                    savedAnnotations={savedAnnotations}
                    onSaveAnnotation={handleSaveAnnotation}
                    onRoiStats={setHuStats}
                  />
                ) : (
                  // Mosaïque 2D : N cellules de la MÊME série, chacune avec son
                  // propre moteur/tool group/viewport (instanceKey unique). Seule
                  // la cellule active pilote la barre d'outils, persiste les
                  // annotations et reçoit l'id #cornerstone-viewport (capture).
                  <div
                    className={`absolute inset-0 ${layoutGridClass(
                      viewportLayout
                    )} gap-0.5 bg-border`}
                  >
                    {Array.from({
                      length: layoutCellCount(viewportLayout),
                    }).map((_, i) => {
                      const isActive = i === activeCell;
                      return (
                        <div
                          key={`cell-${i}`}
                          id={isActive ? "cornerstone-viewport" : undefined}
                          onMouseDownCapture={() => setActiveCell(i)}
                          onWheelCapture={() => setActiveCell(i)}
                          className={`relative bg-black overflow-hidden ring-inset ${
                            isActive
                              ? "ring-2 ring-primary"
                              : "ring-1 ring-border"
                          }`}
                        >
                          <CornerstoneViewer
                            ref={isActive ? activeViewerRef : undefined}
                            instanceKey={`cell${i}`}
                            imageUrls={cellImageUrls}
                            currentSlice={currentSlice}
                            onSliceChange={
                              isActive ? setCurrentSlice : () => {}
                            }
                            activeTool={activeTool}
                            windowWidth={windowWidth}
                            windowCenter={windowCenter}
                            onWindowLevelChange={
                              isActive
                                ? (ww, wc) => {
                                    setWindowWidth(ww);
                                    setWindowCenter(wc);
                                  }
                                : () => {}
                            }
                            onZoomChange={isActive ? setZoomPercent : undefined}
                            instances={cellInstances}
                            // Seule la cellule active hydrate/persiste les
                            // annotations : évite la double-sauvegarde (les
                            // événements d'annotation sont globaux à Cornerstone).
                            savedAnnotations={
                              isActive ? savedAnnotations : undefined
                            }
                            onSaveAnnotation={
                              isActive ? handleSaveAnnotation : undefined
                            }
                            onRoiStats={isActive ? setHuStats : undefined}
                          />
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <VolumeViewer
                  mode={viewMode === "3d" ? "3d" : "mpr"}
                  imageUrls={volumeImageUrls}
                  slabThicknessMm={slabThicknessMm}
                  slabMode={slabMode}
                  preset3d={preset3d}
                  realistic3d={realistic3d}
                  petImageUrls={fusionActive ? petImageUrls : undefined}
                  fusionOpacity={fusionOpacity}
                  petColormapId={petColormapId}
                />
              )}
            </div>

            {/* Calque de caviardage (PHI brûlé). Affiche les rectangles déjà
                posés (toujours visibles en 2D) et, quand l'outil « Caviarder »
                est actif, capte la souris pour tracer un nouveau rectangle. Les
                zones sont recomposées en noir opaque sur les exports. */}
            {viewMode === "2d" &&
              viewportLayout === "1x1" &&
              (currentRedactions.length > 0 || redactActive) && (
                <div
                  className="absolute inset-0"
                  style={{
                    pointerEvents: redactActive ? "auto" : "none",
                    cursor: redactActive ? "crosshair" : "default",
                    zIndex: 20,
                  }}
                  onMouseDown={redactActive ? handleRedactDown : undefined}
                  onMouseMove={redactActive ? handleRedactMove : undefined}
                  onMouseUp={redactActive ? handleRedactUp : undefined}
                  onMouseLeave={
                    redactActive
                      ? () => redactDraft && setRedactDraft(null)
                      : undefined
                  }
                >
                  {/* Rectangles posés : noir opaque (rendu à l'identique de
                      l'export). */}
                  {currentRedactions.map((r, i) => (
                    <div
                      key={`redact-${i}`}
                      className="absolute bg-black"
                      style={{
                        left: `${r.x * 100}%`,
                        top: `${r.y * 100}%`,
                        width: `${r.w * 100}%`,
                        height: `${r.h * 100}%`,
                      }}
                    />
                  ))}
                  {/* Rectangle en cours de tracé (contour pointillé). */}
                  {redactDraft && (
                    <div
                      className="absolute bg-black/70 border border-dashed border-white/70"
                      style={{
                        left: Math.min(redactDraft.startX, redactDraft.curX),
                        top: Math.min(redactDraft.startY, redactDraft.curY),
                        width: Math.abs(redactDraft.curX - redactDraft.startX),
                        height: Math.abs(redactDraft.curY - redactDraft.startY),
                      }}
                    />
                  )}
                </div>
              )}

            {/* Barre de caviardage : annuler / tout effacer (2D, outil actif ou
                zones présentes). */}
            {viewMode === "2d" &&
              viewportLayout === "1x1" &&
              (redactActive || currentRedactions.length > 0) && (
                <div
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card/90 border border-border rounded px-2 py-1 text-[11px]"
                  style={{ zIndex: 30 }}
                >
                  <span className="text-muted-foreground">
                    Caviardage : {currentRedactions.length} zone(s)
                  </span>
                  <button
                    className="px-2 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
                    onClick={undoRedaction}
                    disabled={currentRedactions.length === 0}
                  >
                    Annuler
                  </button>
                  <button
                    className="px-2 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
                    onClick={clearRedactions}
                    disabled={currentRedactions.length === 0}
                  >
                    Tout effacer
                  </button>
                </div>
              )}

            {/* Overlay - Patient Info (top-left) */}
            {study && (
              <div className="absolute top-3 left-3 text-[11px] text-green-400/80 font-mono space-y-0.5 pointer-events-none">
                <div>{study.patientName || "Unknown"}</div>
                <div>{study.patientId || ""}</div>
                <div>{study.studyDate || ""}</div>
                <div>{study.studyDescription || ""}</div>
              </div>
            )}

            {/* Overlay - Window/Level (top-right) */}
            <div className="absolute top-3 right-3 text-[11px] text-green-400/80 font-mono space-y-0.5 pointer-events-none text-right">
              <div>WW: {windowWidth}</div>
              <div>WC: {windowCenter}</div>
              <div>
                Slice: {currentSlice + 1}/{totalSlices}
              </div>
            </div>

            {/* Overlay - HU Statistics (bottom-left) */}
            {/* Barre CLUT (« Color Look Up Table Bar ») : palette active + bornes */}
            {viewMode === "2d" && clutGradient && (
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
                <span className="font-mono text-[9px] text-green-400/80">
                  {Math.round(windowCenter + windowWidth / 2)}
                </span>
                <div
                  className="h-32 w-3 rounded-sm border border-green-400/30"
                  style={{ background: clutGradient }}
                />
                <span className="font-mono text-[9px] text-green-400/80">
                  {Math.round(windowCenter - windowWidth / 2)}
                </span>
              </div>
            )}
            {/* Étiquettes d'orientation anatomique aux bords (A/P/L/R/H/F) */}
            {viewMode === "2d" && orientLabels && (
              <div className="pointer-events-none absolute inset-0 text-[11px] font-mono font-semibold text-green-400/70">
                <span className="absolute top-1 left-1/2 -translate-x-1/2">
                  {orientLabels.top}
                </span>
                <span className="absolute bottom-9 left-1/2 -translate-x-1/2">
                  {orientLabels.bottom}
                </span>
                <span className="absolute left-1 top-1/2 -translate-y-1/2">
                  {orientLabels.left}
                </span>
                <span className="absolute right-1 top-1/2 -translate-y-1/2">
                  {orientLabels.right}
                </span>
              </div>
            )}
            <div className="absolute bottom-3 left-3 text-[10px] text-green-400/60 font-mono pointer-events-none">
              <div>Zoom: {zoomPercent}%</div>
              {huStats && (
                <div className="mt-1 border border-green-400/30 rounded px-2 py-1 bg-black/60">
                  <div className="text-green-400/90 font-semibold text-[9px] mb-0.5">
                    ROI Statistics (HU)
                  </div>
                  <div>Mean: {huStats.mean.toFixed(1)} HU</div>
                  <div>StdDev: {huStats.stdDev.toFixed(1)} HU</div>
                  <div>
                    Min: {huStats.min.toFixed(0)} / Max:{" "}
                    {huStats.max.toFixed(0)}
                  </div>
                  <div>Area: {huStats.area.toFixed(1)} mm²</div>
                  {huStats.histogram && huStats.histogram.length > 0 && (
                    <div className="mt-1">
                      <div className="text-green-400/70 text-[8px] mb-0.5">
                        Histogramme
                      </div>
                      <div className="flex items-end gap-px h-8 w-40">
                        {(() => {
                          const max = Math.max(...huStats.histogram!, 1);
                          return huStats.histogram!.map((c, i) => (
                            <div
                              key={i}
                              className="flex-1 bg-green-400/50"
                              style={{
                                height: `${Math.max(1, (c / max) * 100)}%`,
                              }}
                              title={`${c}`}
                            />
                          ));
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Report panel — overlays the right side of the viewport */}
            {reportOpen && study && (
              <ReportPanel
                studyId={study.id}
                seriesId={selectedSeries!}
                windowWidth={windowWidth}
                windowCenter={windowCenter}
                keyImages={reportKeyImages}
                seriesList={seriesList as any}
                onRemoveKeyImage={i =>
                  setReportKeyImages(p => p.filter((_, idx) => idx !== i))
                }
                onAddKeyImage={img => setReportKeyImages(p => [...p, img])}
                onClose={() => setReportOpen(false)}
              />
            )}

            {/* Panneau Curved MPR (bêta) : overlay autonome, n'altère pas les
                viewports. Disponible en mode MPR (volume chargé). */}
            {curvedMprOpen && viewMode === "mpr" && (
              <CurvedMprPanel onClose={() => setCurvedMprOpen(false)} />
            )}
          </div>

          {/* Bottom Controls */}
          <div className="h-10 border-t border-border bg-card flex items-center px-3 gap-3 shrink-0">
            {/* Slice navigation */}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentSlice(0)}
            >
              <SkipBack className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentSlice(prev => Math.max(0, prev - 1))}
            >
              <ChevronLeft className="w-3 h-3" />
            </Button>

            <div className="flex-1 flex items-center gap-2">
              <Slider
                value={[currentSlice]}
                max={Math.max(0, totalSlices - 1)}
                step={1}
                onValueChange={([v]) => setCurrentSlice(v)}
                className="flex-1"
              />
              <span className="text-[10px] text-muted-foreground font-mono w-16 text-right">
                {currentSlice + 1} / {totalSlices}
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() =>
                setCurrentSlice(prev => Math.min(totalSlices - 1, prev + 1))
              }
            >
              <ChevronRight className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCurrentSlice(totalSlices - 1)}
            >
              <SkipForward className="w-3 h-3" />
            </Button>

            <Separator orientation="vertical" className="h-6" />

            {/* Ciné / boucle */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={toggleCine}
                disabled={totalSlices <= 1}
                title={
                  cinePlaying ? "Pause (Espace)" : "Lecture en boucle (Espace)"
                }
              >
                {cinePlaying ? (
                  <Pause className="w-3 h-3" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
              </Button>
              <select
                value={cineFps}
                onChange={e => setCineFps(Number(e.target.value))}
                className="bg-transparent text-[10px] border border-border rounded px-1 py-0.5 text-muted-foreground"
                title="Cadence du ciné (images/seconde)"
              >
                {CINE_FPS_OPTIONS.map(fps => (
                  <option key={fps} value={fps}>
                    {fps} ips
                  </option>
                ))}
              </select>
            </div>

            <Separator orientation="vertical" className="h-6" />

            {/* W/L Presets */}
            <div className="flex items-center gap-1">
              {QUICK_PRESETS.map(preset => (
                <button
                  key={preset.name}
                  onClick={() => {
                    setWindowWidth(preset.ww);
                    setWindowCenter(preset.wc);
                  }}
                  className="text-[9px] px-2 py-1 rounded bg-secondary hover:bg-accent text-secondary-foreground transition-colors"
                  title={`${preset.name} (WW:${preset.ww} WC:${preset.wc})`}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Panel - Info */}
        <div className="w-56 border-l border-border bg-sidebar flex flex-col shrink-0">
          <div className="p-3 border-b border-border">
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Study Info
            </h3>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-3">
              {study ? (
                <>
                  <InfoRow label="Patient" value={study.patientName || "-"} />
                  <InfoRow label="DOB" value={study.birthDate || "-"} />
                  <InfoRow label="Study Date" value={study.studyDate || "-"} />
                  <InfoRow label="Modality" value={study.modality || "-"} />
                  <InfoRow
                    label="Description"
                    value={study.studyDescription || "-"}
                  />
                  <InfoRow
                    label="Institution"
                    value={study.institution || "-"}
                  />
                  <InfoRow
                    label="Referring"
                    value={study.referringPhysician || "-"}
                  />
                  <InfoRow
                    label="Series"
                    value={String(study.numberOfSeries || 0)}
                  />
                  <InfoRow
                    label="Images"
                    value={String(study.numberOfInstances || 0)}
                  />
                  <Separator className="my-2" />
                  <InfoRow label="Window Width" value={String(windowWidth)} />
                  <InfoRow label="Window Center" value={String(windowCenter)} />
                  <InfoRow
                    label="Current Slice"
                    value={`${currentSlice + 1}/${totalSlices}`}
                  />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No study selected
                </p>
              )}
            </div>
          </ScrollArea>

          {/* W/L Presets Panel */}
          <div className="border-t border-border p-3">
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              W/L Presets
            </h3>
            <div className="space-y-1">
              {WL_PRESETS.map(preset => (
                <button
                  key={preset.name}
                  onClick={() => {
                    setWindowWidth(preset.ww);
                    setWindowCenter(preset.wc);
                  }}
                  className="w-full text-left text-[10px] px-2 py-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                >
                  {preset.name}{" "}
                  <span className="text-muted-foreground/60">
                    ({preset.ww}/{preset.wc})
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-2">
      <span className="text-[10px] text-muted-foreground shrink-0">
        {label}
      </span>
      <span className="text-[10px] text-foreground text-right truncate">
        {value}
      </span>
    </div>
  );
}
