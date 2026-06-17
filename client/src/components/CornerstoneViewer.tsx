import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { patchImagerPixelSpacing } from "@/lib/imagerPixelSpacing";
import { getColormapLut, isValidColormap } from "@/lib/colormaps";
import { lookupTag, formatTagValue } from "@/lib/dicomTagDictionary";
import { computeHistogram } from "@/lib/roiHistogram";
import { growRegion2D } from "@/lib/regionGrow";
import { erode, dilate } from "@/lib/morphology";
import { CONVOLUTION_KERNELS, applyKernel } from "@/lib/convolution";
import {
  isSegmentationTool,
  resolveBrushStrategy,
  segmentationIdForViewport,
  DEFAULT_SEGMENT_INDEX,
  DEFAULT_BRUSH_SIZE,
} from "@/lib/segmentation";
import {
  toolNameToDbType,
  resolveInstanceId,
  extractRoiStats,
  type AnnotationDbType,
  type RoiStats,
  type InstanceLike,
} from "@/lib/annotationMapping";
import type { CursorData } from "@/lib/viewportOverlay";
import { computeScaleBar } from "@/lib/scaleBar";

/**
 * CornerstoneViewer - Renders DICOM images using Cornerstone3D
 * Handles initialization, image loading, and tool interactions
 */

// One annotation the parent asks us to persist. `data` is the full,
// JSON-serializable Cornerstone annotation object.
export interface AnnotationToSave {
  instanceId: number;
  type: AnnotationDbType;
  data: unknown;
}

// A previously-saved annotation row used for re-hydration. `data` is the
// serialized Cornerstone annotation object stored at save time.
export interface SavedAnnotation {
  data: unknown;
}

interface CornerstoneViewerProps {
  imageUrls: string[];
  currentSlice: number;
  onSliceChange: (slice: number) => void;
  activeTool: string;
  windowWidth: number;
  windowCenter: number;
  onWindowLevelChange: (ww: number, wc: number) => void;
  onZoomChange?: (zoomPercent: number) => void;
  /** Series instances (id + storageUrl) used to map annotations → DB rows. */
  instances?: InstanceLike[];
  /** Saved annotations to re-draw once the viewport is ready. */
  savedAnnotations?: SavedAnnotation[];
  /** Called when a measurement is completed/modified and should be persisted. */
  onSaveAnnotation?: (annotation: AnnotationToSave) => void;
  /** Called with ROI HU stats (or null) so the parent can show/hide the overlay. */
  onRoiStats?: (stats: RoiStats | null) => void;
  /**
   * Identifiant unique de l'instance pour les dispositions multi-viewports.
   * Par défaut absent → ids historiques (viewport unique inchangé). Quand
   * plusieurs CornerstoneViewer sont montés (grille 1x2/2x2), chaque cellule
   * doit recevoir un instanceKey distinct pour ne pas entrer en collision sur
   * le moteur de rendu / le tool group / l'id de viewport partagés.
   */
  instanceKey?: string;
  /** Émet la position curseur (image px + mm + valeur) au survol ; null à la sortie. */
  onCursor?: (c: CursorData | null) => void;
}

// Poignée impérative exposée au parent : permet à la barre d'outils de demander
// l'effacement du labelmap de CE viewport sans remonter d'état (la segmentation
// vit dans Cornerstone, pas dans React).
export interface CornerstoneViewerHandle {
  clearSegmentation: () => void;
  /** Applique une palette couleur (CLUT) façon Horos ; null = niveaux de gris. */
  setColormap: (name: string | null) => void;
  /** Fixe le fenêtrage VOI (centre/largeur) — presets WL/WW. */
  setVoi: (windowCenter: number, windowWidth: number) => void;
  /** Inverse la vidéo (négatif). */
  setInvert: (invert: boolean) => void;
  /** Rotation absolue en degrés (0/90/180/270). */
  setRotation: (deg: number) => void;
  /** Bascule le miroir horizontal ou vertical. */
  flip: (axis: "h" | "v") => void;
  /** Réinitialise la vue (caméra + propriétés) — « Reset Image View ». */
  resetView: () => void;
  /** Tous les tags DICOM de l'image courante (inspecteur « DICOM Meta-Data »). */
  getDicomTags: () => Promise<
    Array<{ tag: string; name: string; vr: string; value: string }>
  >;
  /** ImageOrientationPatient (6 valeurs) de l'image courante, ou null. */
  getImageOrientation: () => Promise<number[] | null>;
  /** Fonction VOI LUT : linéaire (défaut) ou sigmoïde (« Use VOI LUT »). */
  setVoiLutFunction: (fn: "LINEAR" | "SIGMOID") => void;
  /** Morphologie sur le masque peint (« Brush ROIs ») : érosion/dilatation. */
  applyMorphology: (op: "erode" | "dilate") => void;
  /** Efface le masque peint (Pinceau/Gomme) de la coupe courante. */
  clearPaintMask: () => void;
  /** Règle le rayon du pinceau (en pixels image). */
  setBrushRadius: (r: number) => void;
  /** Filtre de convolution appliqué à la coupe (nom de noyau, ou null = aucun). */
  setConvolution: (name: string | null) => void;
  /** DSA : capture la coupe affichée comme masque de soustraction. */
  captureDsaMask: () => void;
  /** DSA : active/désactive l'affichage soustrait (live − masque). */
  setDsaActive: (active: boolean) => void;
  /** Assigne un outil au bouton DROIT (façon « Change the mouse button function »). */
  setSecondaryTool: (toolId: string) => void;
  /** Dimensions (cols×rows) de l'image courante, ou null. */
  getImageDimensions: () => { cols: number; rows: number } | null;
}

/**
 * Enregistre les palettes CLUT (issues de lib/colormaps) dans Cornerstone une
 * seule fois par nom. Cornerstone attend des `RGBPoints` à plat
 * [scalaire, r, g, b, …] avec r/g/b dans [0,1] ; on les dérive de la LUT 256³.
 */
const registeredColormaps = new Set<string>();
async function ensureColormapRegistered(name: string): Promise<boolean> {
  if (!isValidColormap(name)) return false;
  if (registeredColormaps.has(name)) return true;
  try {
    const cornerstone = await import("@cornerstonejs/core");
    const register = (cornerstone as any).utilities?.colormap?.registerColormap;
    if (typeof register !== "function") return false;
    const lut = getColormapLut(name); // Uint8ClampedArray de 256*3
    const RGBPoints: number[] = [];
    const n = lut.length / 3;
    for (let i = 0; i < n; i++) {
      RGBPoints.push(
        i / (n - 1),
        lut[i * 3] / 255,
        lut[i * 3 + 1] / 255,
        lut[i * 3 + 2] / 255
      );
    }
    register({ name, ColorSpace: "RGB", RGBPoints });
    registeredColormaps.add(name);
    return true;
  } catch (e) {
    console.warn("[Cornerstone3D] enregistrement CLUT ignoré:", e);
    return false;
  }
}

// Cornerstone3D initialization state
let cornerstoneInitialized = false;
let initPromise: Promise<void> | null = null;

export async function initCornerstone() {
  if (cornerstoneInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const cornerstone = await import("@cornerstonejs/core");
      const cornerstoneTools = await import("@cornerstonejs/tools");
      const dicomImageLoader = await import(
        "@cornerstonejs/dicom-image-loader"
      );

      // Initialize cornerstone core
      await cornerstone.init();

      // Register the DICOM image loader: this wires up the `wadouri:`/`wadors:`
      // schemes, web workers and codecs, and the metadata provider. Without it
      // the `wadouri:` image IDs have no registered loader, so setStack loads
      // nothing and the viewport stays blank.
      // Décodage parallèle (web workers) + plus de requêtes réseau simultanées :
      // une série CT = des centaines de fichiers volumineux ; sans ça, les coupes
      // se chargent quasi une par une. On sature la bande passante (surtout utile
      // sur la démo cloud ; sur le LAN on-prem c'est quasi instantané).
      const workers = Math.max(2, (navigator.hardwareConcurrency || 4) - 1);
      dicomImageLoader.init({ maxWebWorkers: workers });
      try {
        const RT = (cornerstone as any).Enums.RequestType;
        const pool = (cornerstone as any).imageLoadPoolManager;
        pool.setMaxSimultaneousRequests(RT.Interaction, 10);
        pool.setMaxSimultaneousRequests(RT.Prefetch, 10);
      } catch (e) {
        console.warn("[Cornerstone3D] réglage du pool de requêtes ignoré:", e);
      }

      // Calibration des mesures sur les radios standard (CR/DX) : le loader ne
      // lit que PixelSpacing (0028,0030). Quand il manque mais que
      // l'ImagerPixelSpacing (0018,1164) est présent, on fournit le spacing
      // détecteur pour que Length/Angle/ROI mesurent en mm (et non en pixels).
      registerImagerPixelSpacingFallback(cornerstone, dicomImageLoader);

      // Initialize tools
      cornerstoneTools.init();

      // Add tools
      cornerstoneTools.addTool(cornerstoneTools.WindowLevelTool);
      cornerstoneTools.addTool(cornerstoneTools.PanTool);
      cornerstoneTools.addTool(cornerstoneTools.ZoomTool);
      cornerstoneTools.addTool(cornerstoneTools.StackScrollTool);
      cornerstoneTools.addTool(cornerstoneTools.LengthTool);
      cornerstoneTools.addTool(cornerstoneTools.AngleTool);
      cornerstoneTools.addTool(cornerstoneTools.EllipticalROITool);
      cornerstoneTools.addTool(cornerstoneTools.RectangleROITool);
      cornerstoneTools.addTool(cornerstoneTools.ArrowAnnotateTool);
      // Outils de mesure étendus : angle de Cobb (rachis), bidirectionnel
      // (RECIST), sonde HU ponctuelle, ROI à main levée.
      cornerstoneTools.addTool(cornerstoneTools.CobbAngleTool);
      cornerstoneTools.addTool(cornerstoneTools.BidirectionalTool);
      cornerstoneTools.addTool(cornerstoneTools.ProbeTool);
      cornerstoneTools.addTool(cornerstoneTools.PlanarFreehandROITool);
      // Segmentation MVP (client only) : pinceau/gomme partageant une instance de
      // BrushTool ; la bascule peindre/effacer se fait via la stratégie active.
      cornerstoneTools.addTool(cornerstoneTools.BrushTool);

      cornerstoneInitialized = true;
      console.log("[Cornerstone3D] Initialized successfully");
    } catch (err) {
      console.error("[Cornerstone3D] Initialization failed:", err);
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

// Enregistre un provider de métadonnées PRIORITAIRE qui calibre les mesures à
// partir de l'ImagerPixelSpacing (0018,1164) quand le PixelSpacing (0028,0030)
// est absent — cas fréquent des radios standard (CR/DX). Réutilise la logique
// exacte du loader (`metadataForDataset`) puis ne corrige QUE le pixel spacing
// via `patchImagerPixelSpacing`. Renvoie `undefined` dans tous les autres cas
// (CT/IRM calibrés, image non chargée, tag absent) → le provider par défaut fait
// foi : aucun changement de comportement hors radios non calibrées.
function registerImagerPixelSpacingFallback(
  cornerstone: any,
  dicomImageLoader: any
) {
  const wadouri = dicomImageLoader?.wadouri;
  const csMeta = cornerstone?.metaData;
  const meta = wadouri?.metaData;
  if (
    !csMeta?.addProvider ||
    !wadouri?.parseImageId ||
    !wadouri?.dataSetCacheManager?.get ||
    !meta?.metadataForDataset ||
    !meta?.getNumberValues
  ) {
    // API du loader indisponible (changement de version) : on ne casse rien,
    // on garde le comportement par défaut.
    console.warn(
      "[Cornerstone3D] Repli ImagerPixelSpacing non enregistré (API loader absente)"
    );
    return;
  }

  const IMAGE_PLANE = "imagePlaneModule";
  const IMAGER_PIXEL_SPACING_TAG = "x00181164";

  // priorité > 0 : exécuté avant le provider par défaut du loader.
  csMeta.addProvider((type: string, imageId: unknown) => {
    if (type !== IMAGE_PLANE || typeof imageId !== "string") return undefined;
    let parsed: { url?: string; frame?: number } | undefined;
    try {
      parsed = wadouri.parseImageId(imageId);
    } catch {
      return undefined;
    }
    if (!parsed?.url) return undefined;
    let url = parsed.url;
    if (parsed.frame) url = `${url}&frame=${parsed.frame}`;
    const dataSet = wadouri.dataSetCacheManager.get(url);
    if (!dataSet) return undefined; // pas encore décodé → provider par défaut

    // Module calculé par le loader (NB : appel direct, pas via metaData.get →
    // aucune récursion à travers la chaîne de providers).
    const mod = meta.metadataForDataset(IMAGE_PLANE, imageId, dataSet);
    const imager = meta.getNumberValues(dataSet, IMAGER_PIXEL_SPACING_TAG, 2);
    return patchImagerPixelSpacing(mod, imager);
  }, 100);
}

// Ids de base (comportement historique du viewport unique). Pour les
// dispositions multi-viewports, on suffixe ces ids avec l'instanceKey afin que
// chaque cellule possède son propre moteur de rendu / tool group / viewport.
const TOOL_GROUP_ID = "horosToolGroup";
const RENDERING_ENGINE_ID = "horosRenderingEngine";
const VIEWPORT_ID = "CT_VIEWPORT";

// Construit les trois ids uniques pour une instance donnée. Sans instanceKey,
// retourne EXACTEMENT les ids historiques → viewport unique strictement
// inchangé.
function resolveIds(instanceKey?: string) {
  const suffix = instanceKey ? `_${instanceKey}` : "";
  return {
    toolGroupId: `${TOOL_GROUP_ID}${suffix}`,
    renderingEngineId: `${RENDERING_ENGINE_ID}${suffix}`,
    viewportId: `${VIEWPORT_ID}${suffix}`,
  };
}

// Maps our toolbar IDs to Cornerstone3D tool names.
function buildToolMap(cst: any): Record<string, string> {
  return {
    wwwl: cst.WindowLevelTool.toolName,
    zoom: cst.ZoomTool.toolName,
    pan: cst.PanTool.toolName,
    scroll: cst.StackScrollTool.toolName,
    length: cst.LengthTool.toolName,
    angle: cst.AngleTool.toolName,
    ellipse: cst.EllipticalROITool.toolName,
    rect: cst.RectangleROITool.toolName,
    text: cst.ArrowAnnotateTool.toolName,
    cobb: cst.CobbAngleTool.toolName,
    bidirectional: cst.BidirectionalTool.toolName,
    probe: cst.ProbeTool.toolName,
    freehand: cst.PlanarFreehandROITool.toolName,
    // Pinceau et gomme pointent vers la MÊME instance de BrushTool : un seul outil
    // Cornerstone, deux stratégies (remplir / effacer) gérées dans applyActiveTool.
    brush: cst.BrushTool.toolName,
    eraser: cst.BrushTool.toolName,
  };
}

// Make the chosen tool the primary-button tool; keep stack scroll on the wheel.
// `secondaryTool` lie un outil au bouton DROIT (défaut W/L, façon Horos).
function applyActiveTool(
  cst: any,
  toolGroup: any,
  activeTool: string,
  secondaryTool: string = "wwwl"
) {
  const map = buildToolMap(cst);
  // Garde défensive : un id d'outil inconnu (ex. ancien « crosshair » absent du
  // map) retombe sur W/L au lieu de faire un return silencieux qui laissait le
  // viewer sans outil actif sur le clic gauche.
  const csName = map[activeTool] || map["wwwl"];
  if (!csName) return;
  Object.values(map).forEach(name => {
    try {
      toolGroup.setToolPassive(name);
    } catch {}
  });
  // Si l'outil du bouton droit est le même que celui du bouton gauche, on lie
  // les deux boutons en un seul appel (sinon le 2nd setToolActive écraserait le
  // binding Primary). Sinon, Primary seul ici + Secondary plus bas.
  const secName = map[secondaryTool] || map["wwwl"];
  const primaryBindings = [{ mouseButton: cst.Enums.MouseBindings.Primary }];
  if (secName === csName) {
    primaryBindings.push({ mouseButton: cst.Enums.MouseBindings.Secondary });
  }
  toolGroup.setToolActive(csName, { bindings: primaryBindings });
  // Segmentation : si l'outil choisi est le pinceau ou la gomme, on bascule la
  // stratégie active du BrushTool (remplir vs effacer). Aucun effet sur les autres
  // outils (resolveBrushStrategy renvoie null).
  const brushStrategy = resolveBrushStrategy(activeTool);
  if (brushStrategy) {
    try {
      toolGroup.setActiveStrategy(cst.BrushTool.toolName, brushStrategy);
    } catch {}
  }
  try {
    toolGroup.setToolActive(cst.StackScrollTool.toolName, {
      bindings: [{ mouseButton: cst.Enums.MouseBindings.Wheel }],
    });
  } catch {}
  // Outil sur le bouton DROIT (W/L par défaut, façon Horos), uniquement si
  // différent de l'outil primaire (sinon déjà lié ci-dessus avec les 2 boutons).
  if (secName && secName !== csName) {
    try {
      toolGroup.setToolActive(secName, {
        bindings: [{ mouseButton: cst.Enums.MouseBindings.Secondary }],
      });
    } catch {}
  }
}

// Dessine la règle calibrée (mm) le long du bord gauche du viewport. Best-effort :
// si le pixel spacing ou la géométrie manquent (computeScaleBar → null), ne dessine
// rien. `zoom` (px écran / px image) est mesuré exactement via worldToCanvas sur
// deux points image distants de 1 px verticalement → indépendant de getZoom().
function drawScaleBar(
  cornerstone: any,
  viewport: any,
  i2w: ((imageId: string, ij: number[]) => number[]) | undefined,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
) {
  try {
    if (!viewport || typeof i2w !== "function") return;
    const imageId = viewport.getCurrentImageId?.();
    if (!imageId || typeof viewport.worldToCanvas !== "function") return;
    const mod = cornerstone?.metaData?.get?.("imagePlaneModule", imageId);
    const rowSp = Number(mod?.rowPixelSpacing);
    const pixelSpacingMm = Number.isFinite(rowSp) && rowSp > 0 ? rowSp : null;
    if (pixelSpacingMm == null) return;
    // zoom = distance écran (px) entre deux points image distants de 1 px en Y.
    const c0 = viewport.worldToCanvas(i2w(imageId, [0, 0]));
    const c1 = viewport.worldToCanvas(i2w(imageId, [0, 1]));
    if (!c0 || !c1) return;
    const zoom = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    const bar = computeScaleBar(pixelSpacingMm, zoom, h);
    if (!bar) return;

    // Barre verticale + ticks + label, à ~16px du bord gauche, centrée en Y.
    const x = 16;
    const y0 = h / 2 - bar.barPx / 2;
    const y1 = h / 2 + bar.barPx / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,0,0.9)";
    ctx.fillStyle = "rgba(255,255,0,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    // Ticks aux extrémités.
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x + 6, y0);
    ctx.moveTo(x, y1);
    ctx.lineTo(x + 6, y1);
    ctx.stroke();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(`${bar.labelMm} mm`, x + 9, h / 2);
    ctx.restore();
  } catch {
    /* règle best-effort */
  }
}

const CornerstoneViewer = forwardRef<
  CornerstoneViewerHandle,
  CornerstoneViewerProps
>(function CornerstoneViewer(
  {
    imageUrls,
    currentSlice,
    onSliceChange,
    activeTool,
    windowWidth,
    windowCenter,
    onWindowLevelChange,
    onZoomChange,
    instances,
    savedAnnotations,
    onSaveAnnotation,
    onRoiStats,
    instanceKey,
    onCursor,
  }: CornerstoneViewerProps,
  ref
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderingEngineRef = useRef<any>(null);
  // Ids uniques par instance, figés au montage (instanceKey ne change pas pour
  // une cellule donnée). Sans instanceKey → ids historiques inchangés.
  const ids = resolveIds(instanceKey);
  const toolGroupIdRef = useRef(ids.toolGroupId);
  const renderingEngineIdRef = useRef(ids.renderingEngineId);
  const viewportIdRef = useRef(ids.viewportId);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const listenersCleanupRef = useRef<(() => void) | null>(null);
  // Id du labelmap de ce viewport (créé après setStack) et drapeau « prêt » pour
  // que clearSegmentation ne tente rien avant l'enregistrement de la segmentation.
  const segmentationIdRef = useRef<string>(
    segmentationIdForViewport(ids.viewportId)
  );
  const segmentationReadyRef = useRef(false);

  // Latest props/state read by the annotation event handler. Kept in refs so
  // the event subscription effect doesn't tear down and re-subscribe on every
  // slice change or callback identity change.
  const instancesRef = useRef<InstanceLike[]>([]);
  const currentSliceRef = useRef(0);
  const onSaveAnnotationRef = useRef<typeof onSaveAnnotation>(undefined);
  const onRoiStatsRef = useRef<typeof onRoiStats>(undefined);
  // Émission de la position curseur (ref pour ne pas relancer l'effet d'init).
  const onCursorRef = useRef<typeof onCursor>(undefined);
  // Outil assigné au bouton DROIT (W/L par défaut, façon Horos).
  const secondaryToolRef = useRef<string>("wwwl");
  // Module cornerstone-core mémorisé pour les lectures synchrones (cache/metaData).
  const cornerstoneCoreRef = useRef<any>(null);
  // Outil actif (ref pour les écouteurs attachés une seule fois, ex. Baguette).
  const activeToolRef = useRef<string>(activeTool);
  // Masque coloré du region-grow : canvas offscreen (résolution image) + imageId
  // de la coupe seed ; overlay <canvas> ajouté impérativement + fonction de tracé.
  const maskOverlayRef = useRef<{
    canvas: HTMLCanvasElement;
    imageId: string;
  } | null>(null);
  const overlayElRef = useRef<HTMLCanvasElement | null>(null);
  const drawMaskOverlayRef = useRef<(() => void) | null>(null);
  // Pinceau/Gomme (« Brush ROIs ») : masque peint manuellement pour la coupe
  // courante (Uint8Array w×h) + rayon. Affiché via le même overlay que le
  // region-grow. Reconstruit le canvas offscreen après chaque coup de pinceau.
  const paintRef = useRef<{
    mask: Uint8Array;
    w: number;
    h: number;
    imageId: string;
  } | null>(null);
  const brushRadiusRef = useRef<number>(6);
  // Reconstruit le canvas offscreen du masque peint + le pousse dans l'overlay.
  const refreshPaintMaskRef = useRef<(() => void) | null>(null);
  // Filtre de convolution actif (nom de noyau) ou null. Appliqué à la coupe
  // affichée via l'overlay, ré-évalué à chaque rendu (slice/W-L).
  const convolutionRef = useRef<string | null>(null);
  // Soustraction DSA (« Subtraction ») : masque de gris capturé + activation.
  const dsaMaskRef = useRef<{
    gray: Uint8ClampedArray;
    w: number;
    h: number;
  } | null>(null);
  const dsaActiveRef = useRef<boolean>(false);
  // annotationUID → JSON of last-saved data, so a small drag (MODIFIED) that
  // doesn't actually change the measurement isn't re-inserted, and so the
  // exact same annotation isn't saved twice in a row.
  const savedSnapshotRef = useRef<Map<string, string>>(new Map());
  // annotationUIDs we hydrated from the DB → never re-save those.
  const hydratedUidsRef = useRef<Set<string>>(new Set());
  const modifiedDebounceRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

  instancesRef.current = instances ?? [];
  currentSliceRef.current = currentSlice;
  onSaveAnnotationRef.current = onSaveAnnotation;
  onRoiStatsRef.current = onRoiStats;
  onCursorRef.current = onCursor;
  activeToolRef.current = activeTool;

  // Effacement du labelmap (bouton « Effacer seg. » de la barre). On retire la
  // valeur du segment actif sur toutes les coupes ; best-effort, sans jamais
  // lever d'erreur dans le flux de lecture. La segmentation étant en mémoire,
  // l'effacement est immédiat et non persisté.
  // Récupère le viewport 2D actif (best-effort, jamais d'exception).
  const getViewport = useCallback(() => {
    try {
      return (
        renderingEngineRef.current?.getViewport(viewportIdRef.current) ?? null
      );
    } catch {
      return null;
    }
  }, []);

  // État local des transformations façon Horos (pour basculer flip/invert).
  const flipStateRef = useRef<{ h: boolean; v: boolean }>({
    h: false,
    v: false,
  });
  const invertStateRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      clearSegmentation: () => {
        if (!segmentationReadyRef.current) return;
        (async () => {
          try {
            const cornerstoneTools = await import("@cornerstonejs/tools");
            const cstSeg = cornerstoneTools.segmentation;
            const segmentationId = segmentationIdRef.current;
            const active =
              cstSeg.segmentIndex?.getActiveSegmentIndex?.(segmentationId) ??
              DEFAULT_SEGMENT_INDEX;
            cstSeg.helpers?.clearSegmentValue?.(segmentationId, active);
          } catch (e) {
            console.warn("[Cornerstone3D] effacement segmentation ignoré:", e);
          }
        })();
      },
      setColormap: (name: string | null) => {
        (async () => {
          const viewport = getViewport();
          if (!viewport) return;
          try {
            if (!name) {
              viewport.setProperties({ colormap: undefined });
            } else {
              const ok = await ensureColormapRegistered(name);
              if (!ok) return;
              viewport.setProperties({ colormap: { name } });
            }
            viewport.render();
          } catch (e) {
            console.warn("[Cornerstone3D] application CLUT ignorée:", e);
          }
        })();
      },
      setVoi: (windowCenter: number, windowWidth: number) => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          viewport.setProperties({
            voiRange: {
              lower: windowCenter - windowWidth / 2,
              upper: windowCenter + windowWidth / 2,
            },
          });
          viewport.render();
          onWindowLevelChange?.(windowWidth, windowCenter);
        } catch (e) {
          console.warn("[Cornerstone3D] application VOI ignorée:", e);
        }
      },
      setInvert: (invert: boolean) => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          invertStateRef.current = invert;
          viewport.setProperties({ invert });
          viewport.render();
        } catch (e) {
          console.warn("[Cornerstone3D] inversion ignorée:", e);
        }
      },
      setRotation: (deg: number) => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          const rotation = ((deg % 360) + 360) % 360;
          if (typeof viewport.setViewPresentation === "function") {
            viewport.setViewPresentation({ rotation });
          } else {
            viewport.setProperties({ rotation });
          }
          viewport.render();
        } catch (e) {
          console.warn("[Cornerstone3D] rotation ignorée:", e);
        }
      },
      flip: (axis: "h" | "v") => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          const next = { ...flipStateRef.current };
          if (axis === "h") next.h = !next.h;
          else next.v = !next.v;
          flipStateRef.current = next;
          viewport.setCamera({ flipHorizontal: next.h, flipVertical: next.v });
          viewport.render();
        } catch (e) {
          console.warn("[Cornerstone3D] miroir ignoré:", e);
        }
      },
      resetView: () => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          flipStateRef.current = { h: false, v: false };
          invertStateRef.current = false;
          if (typeof viewport.resetProperties === "function") {
            viewport.resetProperties();
          }
          if (typeof viewport.resetCamera === "function") {
            viewport.resetCamera();
          }
          viewport.render();
        } catch (e) {
          console.warn("[Cornerstone3D] reset vue ignoré:", e);
        }
      },
      getDicomTags: async () => {
        try {
          const viewport = getViewport();
          if (!viewport) return [];
          const imageId =
            typeof viewport.getCurrentImageId === "function"
              ? viewport.getCurrentImageId()
              : null;
          if (!imageId) return [];
          const dicomImageLoader = await import(
            "@cornerstonejs/dicom-image-loader"
          );
          const wadouri = (dicomImageLoader as any)?.wadouri;
          if (!wadouri?.parseImageId || !wadouri?.dataSetCacheManager?.get)
            return [];
          const parsed = wadouri.parseImageId(imageId);
          if (!parsed?.url) return [];
          let url = parsed.url;
          if (parsed.frame) url = `${url}&frame=${parsed.frame}`;
          const dataSet = wadouri.dataSetCacheManager.get(url);
          if (!dataSet?.elements) return [];
          const out: Array<{
            tag: string;
            name: string;
            vr: string;
            value: string;
          }> = [];
          for (const key of Object.keys(dataSet.elements)) {
            if (!/^x[0-9a-f]{8}$/i.test(key)) continue;
            const group = key.slice(1, 5).toUpperCase();
            const element = key.slice(5, 9).toUpperCase();
            const tag = `${group},${element}`;
            const info = lookupTag(tag);
            const el = dataSet.elements[key];
            const vr = info?.vr || el?.vr || "";
            let raw: string | undefined;
            try {
              raw = dataSet.string(key);
            } catch {
              raw = undefined;
            }
            const value =
              raw != null && raw !== ""
                ? formatTagValue(vr, raw)
                : `<${vr || "?"}, ${el?.length ?? "?"} octets>`;
            out.push({
              tag,
              name: info?.name || info?.keyword || "Tag privé/inconnu",
              vr,
              value,
            });
          }
          out.sort((a, b) => a.tag.localeCompare(b.tag));
          return out;
        } catch (e) {
          console.warn("[Cornerstone3D] lecture tags DICOM ignorée:", e);
          return [];
        }
      },
      getImageOrientation: async () => {
        try {
          const viewport = getViewport();
          const imageId =
            typeof viewport?.getCurrentImageId === "function"
              ? viewport.getCurrentImageId()
              : null;
          if (!imageId) return null;
          const cornerstone = await import("@cornerstonejs/core");
          const mod = (cornerstone as any).metaData?.get?.(
            "imagePlaneModule",
            imageId
          );
          const iop = mod?.imageOrientationPatient;
          if (Array.isArray(iop) && iop.length >= 6) {
            return iop.slice(0, 6).map((n: any) => Number(n));
          }
          return null;
        } catch {
          return null;
        }
      },
      setVoiLutFunction: (fn: "LINEAR" | "SIGMOID") => {
        const viewport = getViewport();
        if (!viewport) return;
        try {
          viewport.setProperties({
            VOILUTFunction: fn === "SIGMOID" ? "SAMPLED_SIGMOID" : "LINEAR",
          });
          viewport.render();
        } catch (e) {
          console.warn("[Cornerstone3D] VOI LUT function ignorée:", e);
        }
      },
      applyMorphology: (op: "erode" | "dilate") => {
        const p = paintRef.current;
        if (!p) return;
        try {
          const next =
            op === "erode"
              ? erode(p.mask, p.w, p.h, 1)
              : dilate(p.mask, p.w, p.h, 1);
          paintRef.current = { ...p, mask: next };
          refreshPaintMaskRef.current?.();
        } catch (e) {
          console.warn("[Cornerstone3D] morphologie ignorée:", e);
        }
      },
      clearPaintMask: () => {
        paintRef.current = null;
        maskOverlayRef.current = null;
        refreshPaintMaskRef.current?.();
        drawMaskOverlayRef.current?.();
      },
      setBrushRadius: (r: number) => {
        brushRadiusRef.current = Math.max(1, Math.min(40, Math.round(r)));
      },
      setConvolution: (name: string | null) => {
        convolutionRef.current = name;
        // Force un rendu Cornerstone (déclenche IMAGE_RENDERED → ré-applique le
        // filtre via l'overlay) ; sinon redraw direct.
        try {
          getViewport()?.render();
        } catch {}
        drawMaskOverlayRef.current?.();
      },
      captureDsaMask: () => {
        try {
          const host = viewportRef.current;
          const csCanvas = host?.querySelector(
            "canvas"
          ) as HTMLCanvasElement | null;
          if (!csCanvas) return;
          const tmp = document.createElement("canvas");
          tmp.width = csCanvas.width;
          tmp.height = csCanvas.height;
          const tctx = tmp.getContext("2d");
          if (!tctx) return;
          tctx.drawImage(csCanvas, 0, 0);
          const src = tctx.getImageData(0, 0, tmp.width, tmp.height);
          const n = tmp.width * tmp.height;
          const gray = new Uint8ClampedArray(n);
          for (let i = 0; i < n; i++) gray[i] = src.data[i * 4];
          dsaMaskRef.current = { gray, w: tmp.width, h: tmp.height };
        } catch {
          /* best-effort */
        }
      },
      setDsaActive: (active: boolean) => {
        dsaActiveRef.current = active;
        try {
          getViewport()?.render();
        } catch {}
        drawMaskOverlayRef.current?.();
      },
      getImageDimensions: () => {
        try {
          const cornerstone = cornerstoneCoreRef.current;
          const viewport = getViewport();
          const imageId = viewport?.getCurrentImageId?.();
          if (!cornerstone || !imageId) return null;
          // Image décodée en cache → colonnes/lignes fiables.
          const image = cornerstone.cache?.getImage?.(imageId);
          if (image?.columns && image?.rows) {
            return { cols: image.columns, rows: image.rows };
          }
          // Repli sur imagePlaneModule (avant décodage complet).
          const mod = cornerstone.metaData?.get?.("imagePlaneModule", imageId);
          if (mod?.columns && mod?.rows) {
            return { cols: mod.columns, rows: mod.rows };
          }
          return null;
        } catch {
          return null;
        }
      },
      setSecondaryTool: (toolId: string) => {
        secondaryToolRef.current = toolId;
        (async () => {
          try {
            const cst = await import("@cornerstonejs/tools");
            const tg = cst.ToolGroupManager.getToolGroup(
              toolGroupIdRef.current
            );
            if (!tg) return;
            // Ré-applique le binding complet (primaire + secondaire) pour rester
            // cohérent avec l'outil gauche courant.
            applyActiveTool(cst, tg, activeToolRef.current, toolId);
          } catch (e) {
            console.warn("[Cornerstone3D] setSecondaryTool ignoré:", e);
          }
        })();
      },
    }),
    [getViewport, onWindowLevelChange]
  );

  // Initialize Cornerstone3D
  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        await initCornerstone();
        if (mounted) {
          setIsInitialized(true);
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || "Failed to initialize viewer");
        }
      }
    };

    setup();
    return () => {
      mounted = false;
    };
  }, []);

  // Event-driven annotation persistence + ROI stats.
  //
  // Replaces the old 1-second polling in Viewer.tsx. We subscribe ONCE (after
  // init) on cornerstone-core's `eventTarget`, where annotation tool events
  // fire. We listen to ANNOTATION_COMPLETED (user finished drawing) and
  // ANNOTATION_MODIFIED (debounced — user edited an existing measurement).
  //
  // We deliberately do NOT listen to ANNOTATION_ADDED: that's what
  // `addAnnotation` fires during hydration, so subscribing to COMPLETED keeps
  // re-drawn annotations from looping back into a save. We also dedupe on
  // annotationUID + a JSON snapshot, and skip any UID we hydrated ourselves.
  useEffect(() => {
    if (!isInitialized) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const cornerstone = await import("@cornerstonejs/core");
      const cornerstoneTools = await import("@cornerstonejs/tools");
      if (disposed) return;
      const { eventTarget } = cornerstone;
      const Events = cornerstoneTools.Enums.Events;

      // Histogramme des valeurs (HU) dans une ROI ellipse/rectangle —
      // « Histogram of Selected ROI » de Horos. Best-effort : on échantillonne
      // la boîte englobante de la ROI dans les pixels de l'image courante
      // (mappage monde→pixel via worldToImageCoords), en testant l'appartenance
      // à l'ellipse le cas échéant, puis on construit 64 classes. Jamais bloquant.
      const computeRoiHistogram = (annotation: any): number[] | undefined => {
        try {
          const toolName = annotation?.metadata?.toolName;
          if (toolName !== "RectangleROI" && toolName !== "EllipticalROI")
            return undefined;
          const imageId = annotation?.metadata?.referencedImageId;
          const pts = annotation?.data?.handles?.points;
          if (!imageId || !Array.isArray(pts) || pts.length < 2)
            return undefined;
          const image = (cornerstone as any).cache?.getImage?.(imageId);
          const pixelData = image?.getPixelData?.();
          const cols = image?.columns;
          const rows = image?.rows;
          if (!pixelData || !cols || !rows) return undefined;
          const slope = image.slope ?? 1;
          const intercept = image.intercept ?? 0;
          const w2i = (cornerstone as any).utilities?.worldToImageCoords;
          if (typeof w2i !== "function") return undefined;
          const ij = pts
            .map((p: number[]) => w2i(imageId, p))
            .filter((p: any) => Array.isArray(p) && p.length >= 2);
          if (ij.length < 2) return undefined;
          const xs = ij.map((p: number[]) => p[0]);
          const ys = ij.map((p: number[]) => p[1]);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const y0 = Math.min(...ys);
          const y1 = Math.max(...ys);
          const minI = Math.max(0, Math.floor(x0));
          const maxI = Math.min(cols - 1, Math.ceil(x1));
          const minJ = Math.max(0, Math.floor(y0));
          const maxJ = Math.min(rows - 1, Math.ceil(y1));
          const cx = (x0 + x1) / 2;
          const cy = (y0 + y1) / 2;
          const rx = (x1 - x0) / 2 || 1;
          const ry = (y1 - y0) / 2 || 1;
          const isEllipse = toolName === "EllipticalROI";
          const values: number[] = [];
          for (let j = minJ; j <= maxJ; j++) {
            for (let i = minI; i <= maxI; i++) {
              if (isEllipse) {
                const dx = (i - cx) / rx;
                const dy = (j - cy) / ry;
                if (dx * dx + dy * dy > 1) continue;
              }
              const v = pixelData[j * cols + i];
              if (v === undefined) continue;
              values.push(v * slope + intercept);
            }
          }
          if (values.length < 2) return undefined;
          return computeHistogram(values, 64).bins;
        } catch {
          return undefined;
        }
      };

      const persist = (annotation: any) => {
        if (!annotation) return;
        const uid: string | undefined = annotation.annotationUID;
        // Never re-save an annotation we hydrated from the DB.
        if (uid && hydratedUidsRef.current.has(uid)) return;

        // ROI stats overlay (best-effort) — replaces the old polling read.
        const stats = extractRoiStats(annotation);
        if (stats) {
          stats.histogram = computeRoiHistogram(annotation);
          onRoiStatsRef.current?.(stats);
        }

        const save = onSaveAnnotationRef.current;
        if (!save) return;
        const dbType = toolNameToDbType(annotation?.metadata?.toolName);
        if (!dbType) return;
        const instanceId = resolveInstanceId(
          annotation?.metadata?.referencedImageId,
          instancesRef.current,
          currentSliceRef.current
        );
        if (instanceId == null) return;

        // Dedupe: don't re-insert an identical snapshot for the same UID.
        let snapshot: string;
        try {
          snapshot = JSON.stringify(annotation);
        } catch {
          snapshot = String(uid ?? Math.random());
        }
        if (uid && savedSnapshotRef.current.get(uid) === snapshot) return;
        if (uid) savedSnapshotRef.current.set(uid, snapshot);

        save({ instanceId, type: dbType, data: annotation });
      };

      const onCompleted = (evt: any) => {
        persist(evt?.detail?.annotation);
      };
      // MODIFIED fires repeatedly during a drag → debounce per annotation so we
      // save at most once shortly after the user stops editing (still a new row
      // per save, but not one per mousemove).
      const onModified = (evt: any) => {
        const annotation = evt?.detail?.annotation;
        const uid: string | undefined = annotation?.annotationUID;
        const key = uid ?? "_anon";
        const prev = modifiedDebounceRef.current.get(key);
        if (prev) clearTimeout(prev);
        modifiedDebounceRef.current.set(
          key,
          setTimeout(() => {
            modifiedDebounceRef.current.delete(key);
            persist(annotation);
          }, 600)
        );
      };

      eventTarget.addEventListener(Events.ANNOTATION_COMPLETED, onCompleted);
      eventTarget.addEventListener(Events.ANNOTATION_MODIFIED, onModified);
      cleanup = () => {
        eventTarget.removeEventListener(
          Events.ANNOTATION_COMPLETED,
          onCompleted
        );
        eventTarget.removeEventListener(Events.ANNOTATION_MODIFIED, onModified);
        modifiedDebounceRef.current.forEach(t => clearTimeout(t));
        modifiedDebounceRef.current.clear();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isInitialized]);

  // Setup rendering engine and viewport
  useEffect(() => {
    if (!isInitialized || !viewportRef.current || imageUrls.length === 0)
      return;

    let mounted = true;

    const setupViewport = async () => {
      try {
        const cornerstone = await import("@cornerstonejs/core");
        const { RenderingEngine, Enums } = cornerstone;

        // Destroy previous engine if exists
        if (renderingEngineRef.current) {
          renderingEngineRef.current.destroy();
        }

        // Create rendering engine
        const renderingEngine = new RenderingEngine(
          renderingEngineIdRef.current
        );
        renderingEngineRef.current = renderingEngine;

        const viewportInput = {
          viewportId: viewportIdRef.current,
          type: Enums.ViewportType.STACK,
          element: viewportRef.current!,
        };

        renderingEngine.enableElement(viewportInput);

        // Get viewport and set images
        const viewport = renderingEngine.getViewport(
          viewportIdRef.current
        ) as any;

        // Convert URLs to wadouri format for cornerstone
        const imageIds = imageUrls.map(url => `wadouri:${url}`);

        await viewport.setStack(imageIds, currentSlice);

        // Cornerstone sizes the canvas from the element at enableElement time.
        // If the container wasn't laid out yet, the canvas keeps its default
        // 300x150 size and the image renders invisibly small (blank viewport).
        // Fit it to the now-laid-out container, and keep it fitted on resize.
        renderingEngine.resize(true, true);
        // ResizeObserver : on rafraîchit le viewport au changement de taille,
        // MAIS on ignore les tailles nulles (sinon Cornerstone calcule un zoom
        // NaN → overlay « Zoom: NaN% » + flot de warnings) et on débounce via
        // rAF (resize() peut modifier le layout et re-déclencher l'observer →
        // boucle de rendu). Ce cas arrive quand un panneau recouvre/redimensionne
        // la zone (ex. ouverture du panneau « Compte rendu »).
        let roRaf = 0;
        const ro = new ResizeObserver(() => {
          const elx = viewportRef.current;
          if (!elx || elx.clientWidth === 0 || elx.clientHeight === 0) return;
          if (roRaf) cancelAnimationFrame(roRaf);
          roRaf = requestAnimationFrame(() => {
            try {
              renderingEngine.resize(true, true);
            } catch {}
          });
        });
        ro.observe(viewportRef.current!);
        resizeObserverRef.current = ro;

        viewport.render();

        // Set initial window/level
        viewport.setProperties({
          voiRange: {
            lower: windowCenter - windowWidth / 2,
            upper: windowCenter + windowWidth / 2,
          },
        });

        // Bind the tool group to THIS viewport. Doing it here — after the
        // viewport is enabled — is essential: the previous code created the
        // tool group in a separate effect that raced ahead of this async
        // setup, so addViewport ran before the viewport existed and the
        // annotation tools (Length, Angle, ROI…) never attached, making every
        // measurement silently do nothing. The engine is rebuilt on each setup,
        // so recreate the group to drop the stale viewport reference.
        const cornerstoneTools = await import("@cornerstonejs/tools");
        const { ToolGroupManager } = cornerstoneTools;
        if (ToolGroupManager.getToolGroup(toolGroupIdRef.current)) {
          ToolGroupManager.destroyToolGroup(toolGroupIdRef.current);
        }
        const toolGroup = ToolGroupManager.createToolGroup(
          toolGroupIdRef.current
        )!;
        [
          cornerstoneTools.WindowLevelTool,
          cornerstoneTools.PanTool,
          cornerstoneTools.ZoomTool,
          cornerstoneTools.StackScrollTool,
          cornerstoneTools.LengthTool,
          cornerstoneTools.AngleTool,
          cornerstoneTools.EllipticalROITool,
          cornerstoneTools.RectangleROITool,
          cornerstoneTools.ArrowAnnotateTool,
          cornerstoneTools.CobbAngleTool,
          cornerstoneTools.BidirectionalTool,
          cornerstoneTools.ProbeTool,
          cornerstoneTools.PlanarFreehandROITool,
          cornerstoneTools.BrushTool,
        ].forEach(T => toolGroup.addTool(T.toolName));
        toolGroup.addViewport(
          viewportIdRef.current,
          renderingEngineIdRef.current
        );
        applyActiveTool(
          cornerstoneTools,
          toolGroup,
          activeTool,
          secondaryToolRef.current
        );

        // --- Segmentation MVP (client only, in-memory labelmap) ---
        // On crée un labelmap STACK dérivé de la pile courante (mêmes imageIds,
        // tampon Uint8) puis on l'enregistre et on ajoute sa représentation au
        // viewport pour que le pinceau peigne une surcouche colorée. Tout repli
        // (API absente, géométrie inattendue) est silencieux : la segmentation est
        // une fonctionnalité additive qui ne doit JAMAIS casser le viewer.
        segmentationReadyRef.current = false;
        try {
          const cstSeg = cornerstoneTools.segmentation;
          const SegEnums = cornerstoneTools.Enums.SegmentationRepresentations;
          const segmentationId = segmentationIdRef.current;

          // Repart d'un état propre si une segmentation du même id traînait
          // (re-setup sur changement de série / re-montage).
          try {
            cstSeg.removeSegmentation?.(segmentationId);
          } catch {}

          // Labelmap dérivé : un imageId Uint8 par coupe source.
          const derived = (cornerstone as any).imageLoader
            .createAndCacheDerivedLabelmapImages
            ? (
                cornerstone as any
              ).imageLoader.createAndCacheDerivedLabelmapImages(imageIds)
            : null;
          const labelmapImageIds: string[] = (derived || [])
            .map((img: any) => img?.imageId)
            .filter((x: any): x is string => typeof x === "string");

          if (labelmapImageIds.length === imageIds.length) {
            cstSeg.addSegmentations([
              {
                segmentationId,
                representation: {
                  type: SegEnums.Labelmap,
                  data: { imageIds: labelmapImageIds },
                },
              },
            ]);
            await cstSeg.addLabelmapRepresentationToViewport(
              viewportIdRef.current,
              [{ segmentationId, type: SegEnums.Labelmap }]
            );
            try {
              cstSeg.activeSegmentation?.setActiveSegmentation?.(
                viewportIdRef.current,
                segmentationId
              );
            } catch {}
            try {
              cstSeg.segmentIndex?.setActiveSegmentIndex?.(
                segmentationId,
                DEFAULT_SEGMENT_INDEX
              );
            } catch {}
            // Taille de pinceau par défaut pour ce tool group.
            try {
              cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(
                toolGroupIdRef.current,
                DEFAULT_BRUSH_SIZE
              );
            } catch {}
            segmentationReadyRef.current = true;
          } else {
            console.warn(
              "[Cornerstone3D] labelmap dérivé indisponible — segmentation désactivée pour cette pile"
            );
          }
        } catch (e) {
          console.warn(
            "[Cornerstone3D] configuration de la segmentation ignorée:",
            e
          );
        }

        // Keep the WW/WC and Zoom overlays in sync with live tool interaction
        // (the WindowLevel and Zoom tools change the viewport directly, not the
        // React state). Translate Cornerstone events back to the parent.
        const el = viewportRef.current!;

        // Préchargement progressif des coupes (autour de la position courante et
        // dans le sens du scroll) en tâche de fond → le défilement devient fluide
        // au lieu de télécharger chaque coupe au moment où on l'affiche.
        try {
          cornerstoneTools.utilities.stackContextPrefetch.enable(el);
        } catch (e) {
          console.warn("[Cornerstone3D] préchargement indisponible:", e);
        }

        const onVoi = (e: any) => {
          const range = e?.detail?.range;
          if (range) {
            onWindowLevelChange(
              Math.round(range.upper - range.lower),
              Math.round((range.upper + range.lower) / 2)
            );
          }
        };
        const onCamera = () => {
          try {
            const z = viewport.getZoom?.();
            if (typeof z === "number" && Number.isFinite(z))
              onZoomChange?.(Math.round(z * 100));
          } catch {}
        };
        el.addEventListener(Enums.Events.VOI_MODIFIED, onVoi);
        el.addEventListener(Enums.Events.CAMERA_MODIFIED, onCamera);
        listenersCleanupRef.current?.();
        listenersCleanupRef.current = () => {
          el.removeEventListener(Enums.Events.VOI_MODIFIED, onVoi);
          el.removeEventListener(Enums.Events.CAMERA_MODIFIED, onCamera);
          try {
            cornerstoneTools.utilities.stackContextPrefetch.disable(el);
          } catch {}
        };

        console.log(
          "[Cornerstone3D] Viewport setup complete with",
          imageIds.length,
          "images"
        );
      } catch (err: any) {
        console.error("[Cornerstone3D] Viewport setup failed:", err);
        if (mounted) {
          setError(err.message || "Failed to setup viewport");
        }
      }
    };

    setupViewport();

    return () => {
      mounted = false;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      listenersCleanupRef.current?.();
      listenersCleanupRef.current = null;
      // La segmentation de l'ancienne pile est invalidée : le prochain
      // setupViewport recrée un labelmap propre (et removeSegmentation y est
      // appelé au début). On marque seulement « non prêt » ici pour bloquer un
      // clearSegmentation pendant la transition.
      segmentationReadyRef.current = false;
    };
  }, [isInitialized, imageUrls]);

  // Teardown au DÉMONTAGE réel uniquement (deps vides) et SEULEMENT pour les
  // instances multi-viewports (instanceKey défini). À la disparition d'une
  // cellule (réduction de la grille 2x2→1x1), on détruit explicitement SON
  // moteur de rendu et SON tool group pour ne pas fuiter un moteur orphelin
  // partageant un id. Le viewport unique (instanceKey absent) ne passe jamais
  // par ici : son comportement historique (moteur réutilisé/détruit au prochain
  // setupViewport) reste STRICTEMENT inchangé. Cet effet ne se ré-exécute jamais
  // (deps figées), donc aucune course avec setupViewport sur un changement de
  // série.
  useEffect(() => {
    return () => {
      if (!instanceKey) return;
      const reId = renderingEngineIdRef.current;
      const tgId = toolGroupIdRef.current;
      const segId = segmentationIdRef.current;
      (async () => {
        try {
          const ct = await import("@cornerstonejs/tools");
          // Retire le labelmap de cette cellule pour ne pas fuiter une
          // segmentation orpheline quand la grille se réduit (2x2→1x1).
          try {
            ct.segmentation.removeSegmentation?.(segId);
          } catch {}
          if (ct.ToolGroupManager.getToolGroup(tgId)) {
            ct.ToolGroupManager.destroyToolGroup(tgId);
          }
        } catch {}
        try {
          const cs = await import("@cornerstonejs/core");
          const eng = (cs as any).getRenderingEngine?.(reId);
          eng?.destroy?.();
        } catch {}
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Baguette magique (« Grow Region » de Horos) : un clic « seed » lance une
  // croissance de région par seuil (lib/regionGrow) ; on renvoie les stats
  // (moyenne/écart-type/min/max/surface + histogramme) via onRoiStats, réutilisant
  // le panneau ROI. Best-effort, jamais bloquant. Distingue clic vs glisser (>5px).
  useEffect(() => {
    if (!isInitialized) return;
    const el = viewportRef.current;
    if (!el) return;
    let downPos: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const start = downPos;
      downPos = null;
      if (activeToolRef.current !== "regiongrow" || !start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      (async () => {
        try {
          const cornerstone = await import("@cornerstonejs/core");
          const viewport = renderingEngineRef.current?.getViewport(
            viewportIdRef.current
          );
          if (!viewport) return;
          const rect = el.getBoundingClientRect();
          const canvasPt: [number, number] = [
            e.clientX - rect.left,
            e.clientY - rect.top,
          ];
          const world = viewport.canvasToWorld?.(canvasPt);
          const imageId = viewport.getCurrentImageId?.();
          if (!world || !imageId) return;
          const w2i = (cornerstone as any).utilities?.worldToImageCoords;
          const ij = typeof w2i === "function" ? w2i(imageId, world) : null;
          if (!ij) return;
          const si = Math.round(ij[0]);
          const sj = Math.round(ij[1]);
          const image = (cornerstone as any).cache?.getImage?.(imageId);
          const pixelData = image?.getPixelData?.();
          const cols = image?.columns;
          const rows = image?.rows;
          if (!pixelData || !cols || !rows) return;
          if (si < 0 || sj < 0 || si >= cols || sj >= rows) return;
          const slope = image.slope ?? 1;
          const intercept = image.intercept ?? 0;
          const seed = pixelData[sj * cols + si];
          const tol = 100; // tolérance en unités brutes autour du seed
          const mask = growRegion2D(
            Array.from(pixelData as ArrayLike<number>),
            cols,
            rows,
            [si, sj],
            seed - tol,
            seed + tol
          );
          let count = 0;
          let sum = 0;
          let sumSq = 0;
          let min = Infinity;
          let max = -Infinity;
          const values: number[] = [];
          for (let k = 0; k < mask.length; k++) {
            if (!mask[k]) continue;
            const hu = pixelData[k] * slope + intercept;
            count++;
            sum += hu;
            sumSq += hu * hu;
            if (hu < min) min = hu;
            if (hu > max) max = hu;
            values.push(hu);
          }
          if (count === 0) return;
          const mean = sum / count;
          const stdDev = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
          const mod = (cornerstone as any).metaData?.get?.(
            "imagePlaneModule",
            imageId
          );
          const sp = mod?.pixelSpacing || [
            mod?.rowPixelSpacing ?? 1,
            mod?.columnPixelSpacing ?? 1,
          ];
          const area = count * (Number(sp?.[0]) || 1) * (Number(sp?.[1]) || 1);
          const histogram = computeHistogram(values, 64).bins;
          onRoiStatsRef.current?.({ mean, stdDev, min, max, area, histogram });

          // Masque coloré : canvas offscreen à la résolution image (rouge
          // translucide là où le masque est à 1), dessiné en overlay sur la coupe.
          try {
            const off = document.createElement("canvas");
            off.width = cols;
            off.height = rows;
            const octx = off.getContext("2d");
            if (octx) {
              const img = octx.createImageData(cols, rows);
              for (let k = 0; k < mask.length; k++) {
                if (mask[k]) {
                  img.data[k * 4] = 255;
                  img.data[k * 4 + 1] = 80;
                  img.data[k * 4 + 2] = 80;
                  img.data[k * 4 + 3] = 140;
                }
              }
              octx.putImageData(img, 0, 0);
              maskOverlayRef.current = { canvas: off, imageId };
              drawMaskOverlayRef.current?.();
            }
          } catch {
            /* overlay best-effort */
          }
        } catch (e) {
          console.warn("[Cornerstone3D] region grow ignoré:", e);
        }
      })();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [isInitialized]);

  // Émission de la position curseur (façon Horos) : à chaque mousemove on calcule
  // les coords image (px), les mm (px × pixelSpacing) et la valeur du pixel, puis
  // on appelle onCursor. mouseleave → onCursor(null). Best-effort : si une API
  // Cornerstone manque, on dégrade proprement (mm/valeur → null) sans planter.
  useEffect(() => {
    if (!isInitialized) return;
    const el = viewportRef.current;
    if (!el) return;
    let csUtils: any = null;
    let csMeta: any = null;
    let csCache: any = null;
    let disposed = false;
    (async () => {
      const cornerstone = await import("@cornerstonejs/core");
      if (disposed) return;
      csUtils = (cornerstone as any).utilities;
      csMeta = (cornerstone as any).metaData;
      csCache = (cornerstone as any).cache;
      cornerstoneCoreRef.current = cornerstone;
    })();

    const emitCursor = (evt: MouseEvent) => {
      const cb = onCursorRef.current;
      if (!cb) return;
      try {
        const viewport = renderingEngineRef.current?.getViewport(
          viewportIdRef.current
        );
        if (!viewport || typeof viewport.canvasToWorld !== "function") {
          cb(null);
          return;
        }
        const rect = el.getBoundingClientRect();
        const canvasPt: [number, number] = [
          evt.clientX - rect.left,
          evt.clientY - rect.top,
        ];
        const world = viewport.canvasToWorld(canvasPt);
        const imageId = viewport.getCurrentImageId?.();
        // Coords image (px) via worldToImageCoords ; repli sur px canvas.
        let xPx = canvasPt[0];
        let yPx = canvasPt[1];
        let onImage = false;
        const w2i = csUtils?.worldToImageCoords;
        if (world && imageId && typeof w2i === "function") {
          const ij = w2i(imageId, world);
          if (Array.isArray(ij) && ij.length >= 2) {
            xPx = ij[0];
            yPx = ij[1];
            onImage = true;
          }
        }
        // mm = px image × pixel spacing (depuis imagePlaneModule). null sinon.
        let xMm: number | null = null;
        let yMm: number | null = null;
        let value: number | null = null;
        if (onImage && imageId) {
          const mod = csMeta?.get?.("imagePlaneModule", imageId);
          const colSp = Number(mod?.columnPixelSpacing);
          const rowSp = Number(mod?.rowPixelSpacing);
          if (Number.isFinite(colSp) && colSp > 0) xMm = xPx * colSp;
          if (Number.isFinite(rowSp) && rowSp > 0) yMm = yPx * rowSp;
          // Valeur du pixel (brute, façon Horos « Val ») via le cache image.
          try {
            const image = csCache?.getImage?.(imageId);
            const pixelData = image?.getPixelData?.();
            const cols = image?.columns;
            const rows = image?.rows;
            const i = Math.round(xPx);
            const j = Math.round(yPx);
            if (
              pixelData &&
              cols &&
              rows &&
              i >= 0 &&
              j >= 0 &&
              i < cols &&
              j < rows
            ) {
              const raw = pixelData[j * cols + i];
              if (raw !== undefined) value = Number(raw);
            }
          } catch {
            /* valeur best-effort */
          }
        }
        cb({ xPx, yPx, xMm, yMm, value });
      } catch {
        onCursorRef.current?.(null);
      }
    };
    const clearCursor = () => onCursorRef.current?.(null);
    el.addEventListener("mousemove", emitCursor);
    el.addEventListener("mouseleave", clearCursor);
    return () => {
      disposed = true;
      el.removeEventListener("mousemove", emitCursor);
      el.removeEventListener("mouseleave", clearCursor);
    };
  }, [isInitialized]);

  // Overlay du masque region-grow : un <canvas> ajouté IMPÉRATIVEMENT par-dessus
  // le canvas Cornerstone (sans toucher au JSX/DOM React). Redessiné à chaque
  // rendu/changement de caméra ; le masque (résolution image) est plaqué sur la
  // coupe via la transformation affine image→canvas (worldToCanvas des coins).
  useEffect(() => {
    if (!isInitialized) return;
    const el = viewportRef.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const cornerstone = await import("@cornerstonejs/core");
      if (disposed || !viewportRef.current) return;
      const overlay = document.createElement("canvas");
      overlay.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2";
      viewportRef.current.appendChild(overlay);
      overlayElRef.current = overlay;

      const draw = () => {
        try {
          const ov = overlayElRef.current;
          const host = viewportRef.current;
          if (!ov || !host) return;
          const ctx = ov.getContext("2d");
          if (!ctx) return;

          // ── Soustraction DSA : live − masque (+128 mi-gris pour le signe) ──
          if (dsaActiveRef.current && dsaMaskRef.current) {
            const csCanvas = host.querySelector(
              "canvas"
            ) as HTMLCanvasElement | null;
            const mask = dsaMaskRef.current;
            if (csCanvas && csCanvas !== ov && csCanvas.width === mask.w) {
              const cw3 = csCanvas.width;
              const ch3 = csCanvas.height;
              if (ov.width !== cw3 || ov.height !== ch3) {
                ov.width = cw3;
                ov.height = ch3;
              }
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              const tmp = document.createElement("canvas");
              tmp.width = cw3;
              tmp.height = ch3;
              const tctx = tmp.getContext("2d");
              if (tctx) {
                tctx.drawImage(csCanvas, 0, 0);
                const src = tctx.getImageData(0, 0, cw3, ch3);
                const n = cw3 * ch3;
                const out = ctx.createImageData(cw3, ch3);
                for (let i = 0; i < n; i++) {
                  let v = src.data[i * 4] - mask.gray[i] + 128;
                  v = v < 0 ? 0 : v > 255 ? 255 : v;
                  out.data[i * 4] = v;
                  out.data[i * 4 + 1] = v;
                  out.data[i * 4 + 2] = v;
                  out.data[i * 4 + 3] = 255;
                }
                ctx.putImageData(out, 0, 0);
              }
            }
            return;
          }

          // ── Filtre de convolution : applique le noyau à la coupe affichée ──
          // On lit le canvas Cornerstone (1er <canvas> ; l'overlay est ajouté
          // après), on filtre le canal de gris, et on plaque le résultat opaque.
          const conv = convolutionRef.current;
          if (conv) {
            const csCanvas = host.querySelector(
              "canvas"
            ) as HTMLCanvasElement | null;
            const kdef = CONVOLUTION_KERNELS.find(k => k.name === conv);
            if (csCanvas && csCanvas !== ov && kdef) {
              const cw2 = csCanvas.width;
              const ch2 = csCanvas.height;
              if (cw2 > 0 && ch2 > 0) {
                if (ov.width !== cw2 || ov.height !== ch2) {
                  ov.width = cw2;
                  ov.height = ch2;
                }
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                const tmp = document.createElement("canvas");
                tmp.width = cw2;
                tmp.height = ch2;
                const tctx = tmp.getContext("2d");
                if (tctx) {
                  tctx.drawImage(csCanvas, 0, 0);
                  const src = tctx.getImageData(0, 0, cw2, ch2);
                  const n = cw2 * ch2;
                  const gray = new Array<number>(n);
                  for (let i = 0; i < n; i++) gray[i] = src.data[i * 4];
                  const filtered = applyKernel(
                    gray,
                    cw2,
                    ch2,
                    kdef.kernel,
                    kdef.divisor,
                    kdef.bias
                  );
                  const out = ctx.createImageData(cw2, ch2);
                  for (let i = 0; i < n; i++) {
                    const v = Math.max(0, Math.min(255, filtered[i] | 0));
                    out.data[i * 4] = v;
                    out.data[i * 4 + 1] = v;
                    out.data[i * 4 + 2] = v;
                    out.data[i * 4 + 3] = 255;
                  }
                  ctx.putImageData(out, 0, 0);
                }
              }
            }
            return;
          }

          const w = host.clientWidth;
          const h = host.clientHeight;
          if (ov.width !== w || ov.height !== h) {
            ov.width = w;
            ov.height = h;
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          const viewport = renderingEngineRef.current?.getViewport(
            viewportIdRef.current
          );
          const i2w = (cornerstone as any).utilities?.imageToWorldCoords;

          // ── Masque coloré (region-grow / pinceau) plaqué sur sa coupe ──
          const data = maskOverlayRef.current;
          if (data && viewport && typeof i2w === "function") {
            const curId = viewport.getCurrentImageId?.();
            if (curId === data.imageId) {
              const cw = data.canvas.width;
              const ch = data.canvas.height;
              const p0 = viewport.worldToCanvas?.(i2w(data.imageId, [0, 0]));
              const px = viewport.worldToCanvas?.(i2w(data.imageId, [cw, 0]));
              const py = viewport.worldToCanvas?.(i2w(data.imageId, [0, ch]));
              if (p0 && px && py) {
                const a = (px[0] - p0[0]) / cw;
                const b = (px[1] - p0[1]) / cw;
                const c = (py[0] - p0[0]) / ch;
                const d = (py[1] - p0[1]) / ch;
                ctx.setTransform(a, b, c, d, p0[0], p0[1]);
                ctx.drawImage(data.canvas, 0, 0);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
              }
            }
          }

          // ── Règle calibrée en mm sur le bord gauche (façon Horos) ──
          // pixelSpacingMm = taille d'un pixel image (mm) ; zoom = px écran par px
          // image, mesuré exactement via deux points image distants de 1 px.
          drawScaleBar(cornerstone, viewport, i2w, ctx, w, h);
        } catch {
          /* tracé best-effort */
        }
      };
      drawMaskOverlayRef.current = draw;

      // ── Pinceau/Gomme (« Brush ROIs ») via l'overlay ──────────────────────
      // Construit le canvas offscreen coloré du masque peint + le pousse dans
      // l'overlay (vert translucide pour distinguer du region-grow rouge).
      const refreshPaint = () => {
        const p = paintRef.current;
        if (!p) {
          maskOverlayRef.current = null;
          draw();
          return;
        }
        const off = document.createElement("canvas");
        off.width = p.w;
        off.height = p.h;
        const octx = off.getContext("2d");
        if (octx) {
          const img = octx.createImageData(p.w, p.h);
          for (let k = 0; k < p.mask.length; k++) {
            if (p.mask[k]) {
              img.data[k * 4] = 80;
              img.data[k * 4 + 1] = 220;
              img.data[k * 4 + 2] = 120;
              img.data[k * 4 + 3] = 150;
            }
          }
          octx.putImageData(img, 0, 0);
          maskOverlayRef.current = { canvas: off, imageId: p.imageId };
        }
        draw();
      };
      refreshPaintMaskRef.current = refreshPaint;

      // Estampe un disque (rayon courant) dans le masque peint à la position
      // pointeur. `erase=true` retire au lieu d'ajouter. Crée/réinitialise le
      // masque quand on change de coupe.
      const stamp = (clientX: number, clientY: number, erase: boolean) => {
        try {
          const viewport = renderingEngineRef.current?.getViewport(
            viewportIdRef.current
          );
          const imageId = viewport?.getCurrentImageId?.();
          if (!viewport || !imageId) return;
          const image = (cornerstone as any).cache?.getImage?.(imageId);
          const cols = image?.columns;
          const rows = image?.rows;
          if (!cols || !rows) return;
          let p = paintRef.current;
          if (!p || p.imageId !== imageId || p.w !== cols || p.h !== rows) {
            p = {
              mask: new Uint8Array(cols * rows),
              w: cols,
              h: rows,
              imageId,
            };
            paintRef.current = p;
          }
          const r = overlay.getBoundingClientRect();
          const world = viewport.canvasToWorld?.([
            clientX - r.left,
            clientY - r.top,
          ]);
          const w2i = (cornerstone as any).utilities?.worldToImageCoords;
          const ij =
            world && typeof w2i === "function" ? w2i(imageId, world) : null;
          if (!ij) return;
          const ci = Math.round(ij[0]);
          const cj = Math.round(ij[1]);
          const rad = brushRadiusRef.current;
          for (let dj = -rad; dj <= rad; dj++) {
            for (let di = -rad; di <= rad; di++) {
              if (di * di + dj * dj > rad * rad) continue;
              const x = ci + di;
              const y = cj + dj;
              if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
              p.mask[y * cols + x] = erase ? 0 : 1;
            }
          }
          refreshPaint();
        } catch {
          /* peinture best-effort */
        }
      };

      let painting = false;
      const isPaintTool = () =>
        activeToolRef.current === "paint" || activeToolRef.current === "erase";
      const onPaintDown = (e: PointerEvent) => {
        if (!isPaintTool()) return;
        painting = true;
        overlay.setPointerCapture?.(e.pointerId);
        stamp(e.clientX, e.clientY, activeToolRef.current === "erase");
      };
      const onPaintMove = (e: PointerEvent) => {
        if (!painting || !isPaintTool()) return;
        stamp(e.clientX, e.clientY, activeToolRef.current === "erase");
      };
      const onPaintUp = () => {
        painting = false;
      };
      overlay.addEventListener("pointerdown", onPaintDown);
      overlay.addEventListener("pointermove", onPaintMove);
      overlay.addEventListener("pointerup", onPaintUp);

      const { eventTarget, Enums } = cornerstone as any;
      const onRendered = (evt: any) => {
        if (evt?.detail?.viewportId === viewportIdRef.current) draw();
      };
      eventTarget.addEventListener(Enums.Events.IMAGE_RENDERED, onRendered);
      draw();
      cleanup = () => {
        try {
          eventTarget.removeEventListener(
            Enums.Events.IMAGE_RENDERED,
            onRendered
          );
        } catch {}
        overlay.removeEventListener("pointerdown", onPaintDown);
        overlay.removeEventListener("pointermove", onPaintMove);
        overlay.removeEventListener("pointerup", onPaintUp);
        overlay.remove();
        overlayElRef.current = null;
        drawMaskOverlayRef.current = null;
        refreshPaintMaskRef.current = null;
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [isInitialized]);

  // L'overlay n'intercepte les clics QUE pour Pinceau/Gomme (sinon les
  // événements doivent passer à Cornerstone : W/L, mesures, region-grow…).
  useEffect(() => {
    const ov = overlayElRef.current;
    if (!ov) return;
    ov.style.pointerEvents =
      activeTool === "paint" || activeTool === "erase" ? "auto" : "none";
    ov.style.cursor =
      activeTool === "paint" || activeTool === "erase"
        ? "crosshair"
        : "default";
  }, [activeTool, isInitialized]);

  // Re-hydration: re-draw previously-saved annotations once the viewport is
  // ready. Runs when the saved set or the loaded stack changes. addAnnotation
  // fires ANNOTATION_ADDED (NOT ANNOTATION_COMPLETED), so this never loops back
  // into a save; we also record each UID in hydratedUidsRef as a belt-and-
  // suspenders guard against re-persisting.
  useEffect(() => {
    if (!isInitialized || imageUrls.length === 0) return;
    if (!savedAnnotations || savedAnnotations.length === 0) return;
    let disposed = false;

    (async () => {
      try {
        const cornerstone = await import("@cornerstonejs/core");
        const cornerstoneTools = await import("@cornerstonejs/tools");
        if (disposed) return;
        const { annotation: annotationModule } = cornerstoneTools;
        const el = viewportRef.current;
        if (!el) return;

        let added = 0;
        for (const row of savedAnnotations) {
          const ann = row?.data as any;
          if (!ann || !ann.metadata) continue;
          const uid: string | undefined = ann.annotationUID;
          // Skip if this annotation is already present (avoid duplicate redraws
          // on re-runs) or already hydrated.
          if (uid) {
            if (hydratedUidsRef.current.has(uid)) continue;
            const existing = annotationModule.state.getAnnotation?.(uid);
            if (existing) {
              hydratedUidsRef.current.add(uid);
              continue;
            }
          }
          try {
            // annotationGroupSelector = the viewport element (FrameOfReference
            // is resolved from it). Mark as not-invalidated so cached stats are
            // kept rather than recomputed against a not-yet-loaded image.
            annotationModule.state.addAnnotation(ann, el);
            if (uid) hydratedUidsRef.current.add(uid);
            added++;
          } catch (e) {
            console.warn("[Cornerstone3D] hydratation annotation ignorée:", e);
          }
        }

        if (added > 0) {
          try {
            const engine = renderingEngineRef.current;
            cornerstoneTools.utilities.triggerAnnotationRenderForViewportIds?.([
              viewportIdRef.current,
            ]);
            engine?.renderViewports?.([viewportIdRef.current]);
          } catch {
            renderingEngineRef.current?.render?.();
          }
        }
      } catch (e) {
        console.warn(
          "[Cornerstone3D] re-hydratation des annotations échouée:",
          e
        );
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isInitialized, imageUrls, savedAnnotations]);

  // Handle slice change
  useEffect(() => {
    if (!isInitialized || !renderingEngineRef.current) return;

    const updateSlice = async () => {
      try {
        const viewport = renderingEngineRef.current.getViewport(
          viewportIdRef.current
        );
        if (viewport) {
          viewport.setImageIdIndex(currentSlice);
          viewport.render();
        }
      } catch (err) {
        // Viewport may not be ready yet
      }
    };

    updateSlice();
  }, [currentSlice, isInitialized]);

  // Handle window/level change
  useEffect(() => {
    if (!isInitialized || !renderingEngineRef.current) return;

    try {
      const viewport = renderingEngineRef.current.getViewport(
        viewportIdRef.current
      );
      if (viewport) {
        viewport.setProperties({
          voiRange: {
            lower: windowCenter - windowWidth / 2,
            upper: windowCenter + windowWidth / 2,
          },
        });
        viewport.render();
      }
    } catch (err) {
      // Viewport may not be ready
    }
  }, [windowWidth, windowCenter, isInitialized]);

  // Handle active tool change — the tool group is created in setupViewport, so
  // here we only re-bind which tool is on the primary mouse button.
  useEffect(() => {
    if (!isInitialized) return;

    (async () => {
      try {
        const cornerstoneTools = await import("@cornerstonejs/tools");
        const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(
          toolGroupIdRef.current
        );
        if (toolGroup) {
          applyActiveTool(
            cornerstoneTools,
            toolGroup,
            activeTool,
            secondaryToolRef.current
          );
        }
      } catch (err) {
        console.error("[Cornerstone3D] Tool change failed:", err);
      }
    })();
  }, [activeTool, isInitialized, imageUrls]);

  // Handle scroll for slice navigation
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        onSliceChange(Math.min(imageUrls.length - 1, currentSlice + 1));
      } else {
        onSliceChange(Math.max(0, currentSlice - 1));
      }
    },
    [currentSlice, imageUrls.length, onSliceChange]
  );

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <div className="text-center p-4">
          <p className="text-sm text-destructive mb-2">Viewer Error</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0 bg-black"
      onWheel={handleWheel}
      style={{ width: "100%", height: "100%" }}
    />
  );
});

export default CornerstoneViewer;
