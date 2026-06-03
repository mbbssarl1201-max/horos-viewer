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
      await import("@cornerstonejs/dicom-image-loader");

      // Initialize cornerstone core
      await cornerstone.init();

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

export default function CornerstoneViewer({
  imageUrls,
  currentSlice,
  onSliceChange,
  activeTool,
  windowWidth,
  windowCenter,
  onWindowLevelChange,
}: CornerstoneViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renderingEngineRef = useRef<any>(null);
  const viewportIdRef = useRef("CT_VIEWPORT");

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
    if (!isInitialized || !viewportRef.current || imageUrls.length === 0) return;

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
        const renderingEngineId = "horosRenderingEngine";
        const renderingEngine = new RenderingEngine(renderingEngineId);
        renderingEngineRef.current = renderingEngine;

        const viewportInput = {
          viewportId: viewportIdRef.current,
          type: Enums.ViewportType.STACK,
          element: viewportRef.current!,
        };

        renderingEngine.enableElement(viewportInput);

        // Get viewport and set images
        const viewport = renderingEngine.getViewport(viewportIdRef.current) as any;

        // Convert URLs to wadouri format for cornerstone
        const imageIds = imageUrls.map((url) => `wadouri:${url}`);

        await viewport.setStack(imageIds, currentSlice);
        viewport.render();

        // Set initial window/level
        viewport.setProperties({
          voiRange: {
            lower: windowCenter - windowWidth / 2,
            upper: windowCenter + windowWidth / 2,
          },
        });

        console.log("[Cornerstone3D] Viewport setup complete with", imageIds.length, "images");
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
    };
  }, [isInitialized, imageUrls]);

  // Handle slice change
  useEffect(() => {
    if (!isInitialized || !renderingEngineRef.current) return;

    const updateSlice = async () => {
      try {
        const viewport = renderingEngineRef.current.getViewport(viewportIdRef.current);
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
      const viewport = renderingEngineRef.current.getViewport(viewportIdRef.current);
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

  // Handle active tool change
  useEffect(() => {
    if (!isInitialized) return;

    const setTool = async () => {
      try {
        const cornerstoneTools = await import("@cornerstonejs/tools");
        const { ToolGroupManager, Enums: ToolEnums } = cornerstoneTools;

        let toolGroup = ToolGroupManager.getToolGroup("horosToolGroup");
        if (!toolGroup) {
          toolGroup = ToolGroupManager.createToolGroup("horosToolGroup");
          toolGroup?.addViewport(viewportIdRef.current, "horosRenderingEngine");

          // Add all tools to group
          toolGroup?.addTool(cornerstoneTools.WindowLevelTool.toolName);
          toolGroup?.addTool(cornerstoneTools.PanTool.toolName);
          toolGroup?.addTool(cornerstoneTools.ZoomTool.toolName);
          toolGroup?.addTool(cornerstoneTools.StackScrollTool.toolName);
          toolGroup?.addTool(cornerstoneTools.LengthTool.toolName);
          toolGroup?.addTool(cornerstoneTools.AngleTool.toolName);
          toolGroup?.addTool(cornerstoneTools.EllipticalROITool.toolName);
          toolGroup?.addTool(cornerstoneTools.RectangleROITool.toolName);
          toolGroup?.addTool(cornerstoneTools.ArrowAnnotateTool.toolName);
        }

        // Map our tool IDs to cornerstone tool names
        const toolMap: Record<string, string> = {
          wwwl: cornerstoneTools.WindowLevelTool.toolName,
          zoom: cornerstoneTools.ZoomTool.toolName,
          pan: cornerstoneTools.PanTool.toolName,
          scroll: cornerstoneTools.StackScrollTool.toolName,
          length: cornerstoneTools.LengthTool.toolName,
          angle: cornerstoneTools.AngleTool.toolName,
          ellipse: cornerstoneTools.EllipticalROITool.toolName,
          rect: cornerstoneTools.RectangleROITool.toolName,
          text: cornerstoneTools.ArrowAnnotateTool.toolName,
        };

        const csToolName = toolMap[activeTool];
        if (csToolName && toolGroup) {
          // Deactivate all tools first
          Object.values(toolMap).forEach((name) => {
            try {
              toolGroup!.setToolPassive(name);
            } catch {}
          });

          // Activate selected tool
          toolGroup.setToolActive(csToolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
          });

          // Always keep scroll on mouse wheel
          toolGroup.setToolActive(cornerstoneTools.StackScrollTool.toolName, {
            bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
          });
        }
      } catch (err) {
        console.error("[Cornerstone3D] Tool change failed:", err);
      }
    };

    setTool();
  }, [activeTool, isInitialized]);

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
