import { useAuth } from "@/_core/hooks/useAuth";
import CornerstoneViewer from "@/components/CornerstoneViewer";
import VolumeViewer from "@/components/VolumeViewer";
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
  SkipBack,
  SkipForward,
  Download,
  Printer,
  Mail,
  Camera,
  FlipHorizontal,
  FlipVertical,
  TriangleAlert,
} from "lucide-react";
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

// Viewer tools
const VIEWER_TOOLS = [
  { id: "wwwl", label: "W/L", icon: Contrast, description: "Window/Level" },
  { id: "zoom", label: "Zoom", icon: ZoomIn, description: "Zoom" },
  { id: "pan", label: "Pan", icon: Move, description: "Pan" },
  { id: "scroll", label: "Scroll", icon: Layers, description: "Stack Scroll" },
  { id: "length", label: "Length", icon: Ruler, description: "Length Measurement" },
  { id: "angle", label: "Angle", icon: TriangleAlert, description: "Angle Measurement" },
  { id: "ellipse", label: "Ellipse", icon: Circle, description: "Elliptical ROI" },
  { id: "rect", label: "Rect", icon: Square, description: "Rectangular ROI" },
  { id: "text", label: "Text", icon: Type, description: "Text Annotation" },
  { id: "crosshair", label: "MPR", icon: Crosshair, description: "Crosshair / MPR" },
];

export default function Viewer() {
  const params = useParams<{ studyId?: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const studyId = params.studyId ? parseInt(params.studyId) : undefined;

  const [activeTool, setActiveTool] = useState("wwwl");
  const [currentSlice, setCurrentSlice] = useState(0);
  const [totalSlices, setTotalSlices] = useState(1);
  const [windowWidth, setWindowWidth] = useState(400);
  const [windowCenter, setWindowCenter] = useState(40);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [selectedSeries, setSelectedSeries] = useState<number | null>(null);
  const [viewportLayout, setViewportLayout] = useState<"1x1" | "1x2" | "2x2">("1x1");
  const [viewMode, setViewMode] = useState<"2d" | "mpr" | "3d">("2d");
  const [huStats, setHuStats] = useState<{ mean: number; stdDev: number; min: number; max: number; area: number } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);

  // Fetch study data
  const { data: study } = trpc.studies.get.useQuery(
    { id: studyId! },
    { enabled: !!studyId }
  );

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

  // Auto-select first series
  useEffect(() => {
    if (seriesList && seriesList.length > 0 && !selectedSeries) {
      setSelectedSeries(seriesList[0].id);
    }
  }, [seriesList, selectedSeries]);

  // Update total slices when instances change
  useEffect(() => {
    if (instancesList) {
      setTotalSlices(Math.max(1, instancesList.length));
      setCurrentSlice(0);
    }
  }, [instancesList]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
        case "ArrowLeft":
          setCurrentSlice((prev) => Math.max(0, prev - 1));
          break;
        case "ArrowDown":
        case "ArrowRight":
          setCurrentSlice((prev) => Math.min(totalSlices - 1, prev + 1));
          break;
        case "r":
          setActiveTool("wwwl");
          break;
        case "z":
          setActiveTool("zoom");
          break;
        case "p":
          setActiveTool("pan");
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [totalSlices]);

  // Cornerstone initialization flag for HU stats polling
  const isViewerReady = !!instancesList && instancesList.length > 0;

  // Listen for ROI annotation completed events to extract HU stats
  useEffect(() => {
    if (!isViewerReady) return;

    const handleAnnotationCompleted = async () => {
      try {
        const cornerstoneTools = await import("@cornerstonejs/tools");
        const { annotation } = cornerstoneTools;
        
        // Get all annotations for the current viewport
        const allAnnotations = annotation.state.getAllAnnotations();
        if (allAnnotations && allAnnotations.length > 0) {
          const lastAnnotation = allAnnotations[allAnnotations.length - 1];
          const data = lastAnnotation?.data;
          
          if (data?.cachedStats) {
            // Extract HU statistics from ROI tools
            const stats = Object.values(data.cachedStats)[0] as any;
            if (stats) {
              setHuStats({
                mean: stats.mean ?? 0,
                stdDev: stats.stdDev ?? 0,
                min: stats.min ?? 0,
                max: stats.max ?? 0,
                area: stats.area ?? 0,
              });
            }
          }
        }
      } catch (err) {
        // Stats extraction is best-effort
      }
    };

    // Poll for annotation changes when ROI tools are active
    const roiTools = ["ellipse", "rect"];
    let interval: ReturnType<typeof setInterval> | null = null;
    
    if (roiTools.includes(activeTool)) {
      interval = setInterval(handleAnnotationCompleted, 1000);
    } else {
      setHuStats(null);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [activeTool, isViewerReady]);

  // Handle scroll on viewport for slice navigation
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) {
        setCurrentSlice((prev) => Math.min(totalSlices - 1, prev + 1));
      } else {
        setCurrentSlice((prev) => Math.max(0, prev - 1));
      }
    },
    [totalSlices]
  );

  // Grab the rendered viewport canvas (the onscreen 2D copy Cornerstone keeps).
  const getViewportCanvas = () =>
    document.querySelector<HTMLCanvasElement>("#cornerstone-viewport canvas");

  // Capture: download the current view as a PNG.
  const handleCapture = useCallback(() => {
    const canvas = getViewportCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `capture_study${studyId ?? ""}_slice${currentSlice + 1}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  }, [studyId, currentSlice]);

  // Export: download the whole study as a ZIP of DICOM files (server route,
  // same-origin so the session cookie authenticates the request).
  const handleExport = useCallback(() => {
    if (!studyId) return;
    window.location.href = `/api/export/dicom-zip/${studyId}`;
  }, [studyId]);

  // Print: open the current view in a print dialog.
  const handlePrint = useCallback(() => {
    const canvas = getViewportCanvas();
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
    img.style.cssText = "max-width:100%;max-height:100vh;display:block;margin:auto";
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
    const canvas = getViewportCanvas();
    if (!canvas || !studyId) {
      toast.error("Aucune image à envoyer");
      return;
    }
    const to = window.prompt("Adresse email du destinataire :");
    if (!to) return;
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();
      doc.setFontSize(15);
      doc.text("Compte rendu d'imagerie", 14, 16);
      doc.setFontSize(10);
      const lines = [
        `Patient : ${study?.patientName || "—"}`,
        `Date d'étude : ${study?.studyDate || "—"}`,
        `Modalité : ${study?.modality || "—"}`,
        `Description : ${study?.studyDescription || "—"}`,
        `Institution : ${study?.institution || "—"}`,
      ];
      lines.forEach((l, i) => doc.text(l, 14, 28 + i * 6));
      const imgData = canvas.toDataURL("image/png");
      const w = 180;
      const h = Math.min(200, (canvas.height / canvas.width) * w);
      doc.addImage(imgData, "PNG", 14, 62, w, h);
      const pdfBase64 = doc.output("datauristring").split(",")[1];

      await sendReportMutation.mutateAsync({
        to,
        studyId,
        pdfBase64,
        filename: `compte-rendu-${studyId}.pdf`,
      });
      toast.success(`Compte rendu PDF envoyé à ${to}`);
    } catch (e: any) {
      toast.error("Échec de l'envoi : " + (e?.message || "erreur"));
    }
  }, [studyId, study, sendReportMutation]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      <div className="h-12 border-b border-border bg-card flex items-center px-2 gap-1 shrink-0">
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
        {VIEWER_TOOLS.map((tool) => (
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
        <button className="toolbar-btn" title="Screenshot (PNG)" onClick={handleCapture}>
          <Camera className="w-4 h-4" />
          <span className="text-[9px]">Capture</span>
        </button>
        <button className="toolbar-btn" title="Export study (DICOM ZIP)" onClick={handleExport}>
          <Download className="w-4 h-4" />
          <span className="text-[9px]">Export</span>
        </button>
        <button className="toolbar-btn" title="Print current view" onClick={handlePrint}>
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
          <span className="text-[9px]">{sendReportMutation.isPending ? "…" : "Email"}</span>
        </button>
      </div>

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
                  {/* Thumbnail placeholder */}
                  <div className="aspect-square bg-black rounded mb-1.5 flex items-center justify-center">
                    <Layers className="w-6 h-6 text-muted-foreground/30" />
                  </div>
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
                  <p className="text-[10px] text-muted-foreground">No series available</p>
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
            <div className="absolute inset-0 dicom-viewport" id="cornerstone-viewport">
              {!instancesList || instancesList.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Layers className="w-16 h-16 text-muted-foreground/20 mx-auto mb-4" />
                    <p className="text-sm text-muted-foreground">
                      {studyId ? "Select a series to view" : "No study selected"}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      Double-click a study from the main list to open it
                    </p>
                  </div>
                </div>
              ) : viewMode === "2d" ? (
                <CornerstoneViewer
                  imageUrls={instancesList.map((inst: any) => inst.storageUrl || '')}
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
                />
              ) : (
                <VolumeViewer
                  imageUrls={instancesList.map((inst: any) => inst.storageUrl || '')}
                  mode={viewMode}
                />
              )}
            </div>

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
            <div className="absolute bottom-3 left-3 text-[10px] text-green-400/60 font-mono pointer-events-none">
              <div>Zoom: {zoomPercent}%</div>
              {huStats && (
                <div className="mt-1 border border-green-400/30 rounded px-2 py-1 bg-black/60">
                  <div className="text-green-400/90 font-semibold text-[9px] mb-0.5">ROI Statistics (HU)</div>
                  <div>Mean: {huStats.mean.toFixed(1)} HU</div>
                  <div>StdDev: {huStats.stdDev.toFixed(1)} HU</div>
                  <div>Min: {huStats.min.toFixed(0)} / Max: {huStats.max.toFixed(0)}</div>
                  <div>Area: {huStats.area.toFixed(1)} mm²</div>
                </div>
              )}
            </div>

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
              onClick={() => setCurrentSlice((prev) => Math.max(0, prev - 1))}
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
              onClick={() => setCurrentSlice((prev) => Math.min(totalSlices - 1, prev + 1))}
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

            {/* W/L Presets */}
            <div className="flex items-center gap-1">
              {WL_PRESETS.slice(0, 4).map((preset) => (
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
                  <InfoRow label="Description" value={study.studyDescription || "-"} />
                  <InfoRow label="Institution" value={study.institution || "-"} />
                  <InfoRow label="Referring" value={study.referringPhysician || "-"} />
                  <InfoRow label="Series" value={String(study.numberOfSeries || 0)} />
                  <InfoRow label="Images" value={String(study.numberOfInstances || 0)} />
                  <Separator className="my-2" />
                  <InfoRow label="Window Width" value={String(windowWidth)} />
                  <InfoRow label="Window Center" value={String(windowCenter)} />
                  <InfoRow label="Current Slice" value={`${currentSlice + 1}/${totalSlices}`} />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No study selected</p>
              )}
            </div>
          </ScrollArea>

          {/* W/L Presets Panel */}
          <div className="border-t border-border p-3">
            <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              W/L Presets
            </h3>
            <div className="space-y-1">
              {WL_PRESETS.map((preset) => (
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
      <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[10px] text-foreground text-right truncate">{value}</span>
    </div>
  );
}
