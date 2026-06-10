import { useEffect, useRef, useState, useCallback } from "react";

/**
 * CornerstoneViewer - Renders DICOM images using Cornerstone3D
 * Handles initialization, image loading, and tool interactions
 */

interface CornerstoneViewerProps {
  imageUrls: string[];
  currentSlice: number;
  onSliceChange: (slice: number) => void;
  activeTool: string;
  windowWidth: number;
  windowCenter: number;
  onWindowLevelChange: (ww: number, wc: number) => void;
  onZoomChange?: (zoomPercent: number) => void;
}

// Cornerstone3D initialization state
let cornerstoneInitialized = false;
let initPromise: Promise<void> | null = null;

async function initCornerstone() {
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
      dicomImageLoader.init();

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

const TOOL_GROUP_ID = "horosToolGroup";
const RENDERING_ENGINE_ID = "horosRenderingEngine";

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
  };
}

// Make the chosen tool the primary-button tool; keep stack scroll on the wheel.
function applyActiveTool(cst: any, toolGroup: any, activeTool: string) {
  const map = buildToolMap(cst);
  const csName = map[activeTool];
  if (!csName) return;
  Object.values(map).forEach(name => {
    try {
      toolGroup.setToolPassive(name);
    } catch {}
  });
  toolGroup.setToolActive(csName, {
    bindings: [{ mouseButton: cst.Enums.MouseBindings.Primary }],
  });
  try {
    toolGroup.setToolActive(cst.StackScrollTool.toolName, {
      bindings: [{ mouseButton: cst.Enums.MouseBindings.Wheel }],
    });
  } catch {}
}

export default function CornerstoneViewer({
  imageUrls,
  currentSlice,
  onSliceChange,
  activeTool,
  windowWidth,
  windowCenter,
  onWindowLevelChange,
  onZoomChange,
}: CornerstoneViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderingEngineRef = useRef<any>(null);
  const viewportIdRef = useRef("CT_VIEWPORT");
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const listenersCleanupRef = useRef<(() => void) | null>(null);

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
        const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
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
        if (ToolGroupManager.getToolGroup(TOOL_GROUP_ID)) {
          ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
        }
        const toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID)!;
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
        ].forEach(T => toolGroup.addTool(T.toolName));
        toolGroup.addViewport(viewportIdRef.current, RENDERING_ENGINE_ID);
        applyActiveTool(cornerstoneTools, toolGroup, activeTool);

        // Keep the WW/WC and Zoom overlays in sync with live tool interaction
        // (the WindowLevel and Zoom tools change the viewport directly, not the
        // React state). Translate Cornerstone events back to the parent.
        const el = viewportRef.current!;
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
    };
  }, [isInitialized, imageUrls]);

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
        const toolGroup =
          cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
        if (toolGroup) {
          applyActiveTool(cornerstoneTools, toolGroup, activeTool);
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
}
