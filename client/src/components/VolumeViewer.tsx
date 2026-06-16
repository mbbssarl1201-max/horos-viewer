import { useEffect, useRef, useState } from "react";
import { slabModeToBlend, type SlabMode } from "@/lib/slabBlend";
import { PRESETS_3D, presetParId } from "@/lib/volumePresets3d";
import { catmullRomSpline } from "@/lib/flyThruPath";
import { turntableAngles, orbitAroundFocalPoint } from "@/lib/turntable";
import {
  clampFusionOpacity,
  petColormapVtkName,
  DEFAULT_PET_COLORMAP_ID,
} from "@/lib/petFusion";

// Ré-export pour compat (Viewer.tsx importe PRESETS_3D depuis ce module).
export { PRESETS_3D } from "@/lib/volumePresets3d";

/**
 * VolumeViewer — real volumetric rendering with Cornerstone3D.
 *
 * mode="mpr": builds a 3D volume from the stack and shows 3 orthogonal
 *             reconstructions (axial / sagittal / coronal) + 1 oblique quad.
 *             Supports ToolGroup (CrosshairsTool, WindowLevelTool, etc.),
 *             VOI synchronizer, and slab thickness/blend-mode.
 * mode="3d" : volume rendering (VR) in a single viewport with a CT preset.
 *
 * Source priority:
 *   1. orthancImageIds (wadors: scheme, from Orthanc via proxy) if provided
 *   2. imageUrls (wadouri: scheme, from MinIO) otherwise
 *
 * Uses its own rendering engine so it never collides with the 2D stack viewer.
 * Cornerstone core must already be initialized (the 2D viewer's initCornerstone
 * registers the streaming volume loader via cornerstone.init()).
 */
interface VolumeViewerProps {
  /** Source locale (MinIO, schéma wadouri:) — conservée pour compat. */
  imageUrls?: string[];
  /** Source Orthanc (imageIds wadors déjà préfixés). Prioritaire si fournie. */
  orthancImageIds?: string[];
  /** volumeId stable fourni par useOrthancVolume (sinon valeur locale par défaut). */
  volumeId?: string;
  mode: "mpr" | "3d";
  /** Épaisseur de coupe en mm (0 = coupe fine). */
  slabThicknessMm?: number;
  /** Mode de projection slab. */
  slabMode?: SlabMode;
  /** Preset de rendu volumique 3D (id de PRESETS_3D). Défaut "os". */
  preset3d?: string;
  /**
   * Mode "3d" uniquement : active le rendu réaliste (éclairage volumétrique
   * cinématique + qualité d'échantillonnage accrue). Défaut ON. L'utilisateur
   * peut le couper si c'est trop lent sur sa machine.
   */
  realistic3d?: boolean;
  /** Mode "3d" : rendu surfacique (iso-surface) au lieu du volume rendering. */
  surface3d?: boolean;
  /** Seuil iso (unités scalaires/HU) pour le rendu surfacique. Défaut ~300 (os CT). */
  surfaceIso?: number;
  /** Compteur : chaque incrément déclenche une animation fly-thru (endoscopie). */
  flyThruNonce?: number;
  /** Mode "3d" : à chaque incrément, exporte une vidéo de rotation (turntable). */
  turntableNonce?: number;
  /** Scissor : fraction [0..0.9] retirée de chaque côté du volume (0 = aucune découpe). */
  cropFraction?: number;
  /**
   * Fusion PET-CT (additif, fail-safe) : URLs (MinIO, schéma wadouri:) des
   * coupes de la série PET à superposer sur le CT/volume principal. Si absent
   * ou < 2 coupes, AUCUNE fusion n'est tentée (comportement historique intact).
   */
  petImageUrls?: string[];
  /** volumeId stable du volume PET (sinon valeur locale par défaut). */
  petVolumeId?: string;
  /** Opacité de fusion du PET (0..1). Défaut 0.5. */
  fusionOpacity?: number;
  /** Id de colormap PET (cf. PET_COLORMAPS). Défaut "hot". */
  petColormapId?: string;
}

const VOLUME_ENGINE_ID = "horosVolumeEngine";
const PET_VOLUME_ID_DEFAULT = "cornerstoneStreamingImageVolume:HOROS_PET_VOL";

/**
 * Applique colormap + opacité au volume PET dans une liste de viewports, de
 * façon ENTIÈREMENT fail-safe (chaque viewport isolé en try/catch). On passe le
 * `petVolumeId` à `setProperties` pour ne cibler QUE le volume PET (le CT garde
 * son rendu en niveaux de gris). `opacity` est portée par la colormap
 * (ColormapPublic.opacity : number → opacité globale du volume coloré).
 */
function applyPetFusionProps(
  engine: any,
  viewportIds: string[],
  petVolumeId: string,
  colormapId: string,
  opacity: number
) {
  const vtkName = petColormapVtkName(colormapId);
  const op = clampFusionOpacity(opacity);
  for (const id of viewportIds) {
    try {
      const vp = engine?.getViewport?.(id);
      if (!vp?.setProperties) continue;
      vp.setProperties(
        { colormap: { name: vtkName, opacity: op } },
        petVolumeId
      );
    } catch {
      // Volume PET pas (encore) présent sur ce viewport → ignorer.
    }
  }
  try {
    engine?.renderViewports?.(viewportIds);
  } catch {}
}

/**
 * Active l'ombrage volumétrique (shading) sur l'acteur 3D pour donner de la
 * profondeur/du relief, APRÈS application d'un preset (le preset peut redéfinir
 * shade/ambient/diffuse/specular). Robuste : l'acteur peut ne pas être prêt
 * immédiatement → tout est encapsulé en try/catch, échec silencieux toléré.
 * Valeurs ambient/diffuse/specular = 0.2 / 0.7 / 0.3 (rendu clinique équilibré).
 */
function applyShading(vp: any) {
  try {
    const actors = vp?.getActors?.();
    if (!actors || !actors.length) return;
    for (const entry of actors) {
      const actor = entry?.actor ?? entry?.volumeActor ?? entry;
      const property = actor?.getProperty?.();
      if (!property) continue;
      property.setShade?.(true);
      property.setAmbient?.(0.2);
      property.setDiffuse?.(0.7);
      property.setSpecular?.(0.3);
      property.setSpecularPower?.(8.0);
      // Opacité de gradient : atténue le « brouillard » homogène, fait ressortir
      // les surfaces. Le preset peut déjà la régler ; on garantit qu'elle est ON.
      property.setUseGradientOpacity?.(0, true);
    }
  } catch {
    // Acteur pas encore prêt — sera ré-appliqué au prochain applyPreset/load.
  }
}

/**
 * Rendu réaliste « cinématique » sur l'acteur 3D (mode "3d" uniquement).
 *
 * Deux leviers, appliqués APRÈS le preset, chacun isolé en try/catch (dégrade
 * gracieusement si une API manque dans la version installée) :
 *
 *  1. Qualité d'échantillonnage via l'API SUPPORTÉE de Cornerstone :
 *     `viewport.setProperties({ sampleDistanceMultiplier, smoothing })`.
 *     Un multiplicateur PLUS BAS = plus d'échantillons par rayon = image plus
 *     nette/fidèle (au prix du GPU). `smoothing` lisse légèrement le bruit CT.
 *
 *  2. Éclairage volumétrique global (global illumination) directement sur la
 *     vtkVolumeProperty de l'acteur. ATTENTION : dans vtk.js 34.x ces réglages
 *     ont MIGRÉ du VolumeMapper vers la VolumeProperty (appeler les setters sur
 *     le mapper LÈVE une erreur explicite). On les pose donc sur la propriété :
 *       • setVolumetricScatteringBlending(~0.5) — diffusion volumétrique
 *       • setGlobalIlluminationReach(~0.3)      — portée de l'éclairage global
 *       • setAnisotropy(~0.3)                   — anisotropie de la diffusion
 *       • setLocalAmbientOcclusion(true) + setComputeNormalFromOpacity(true)
 *         — occlusion ambiante locale (creux/reliefs plus marqués)
 *     `volumeShadowSamplingDistFactor` reste, lui, un setter du MAPPER.
 *
 * `enabled=false` → on neutralise (multiplicateur 1, GI à 0) pour revenir au
 * rendu standard rapide.
 */
function applyCinematic(vp: any, enabled: boolean) {
  // 1. Qualité d'échantillonnage (API Cornerstone supportée).
  try {
    vp?.setProperties?.({
      sampleDistanceMultiplier: enabled ? 0.5 : 1.0,
      smoothing: enabled ? 1 : 0,
    });
  } catch {
    // Propriété absente sur ce type de viewport → ignorer.
  }

  // 2. Éclairage global cinématique sur la VolumeProperty de l'acteur.
  try {
    const actors = vp?.getActors?.();
    if (!actors || !actors.length) return;
    for (const entry of actors) {
      const actor = entry?.actor ?? entry?.volumeActor ?? entry;
      const property = actor?.getProperty?.();
      const mapper = actor?.getMapper?.();
      if (property) {
        // Chaque setter isolé : une version peut en exposer un sous-ensemble.
        try {
          property.setVolumetricScatteringBlending?.(enabled ? 0.5 : 0.0);
        } catch {}
        try {
          property.setGlobalIlluminationReach?.(enabled ? 0.3 : 0.0);
        } catch {}
        try {
          property.setAnisotropy?.(enabled ? 0.3 : 0.0);
        } catch {}
        try {
          property.setComputeNormalFromOpacity?.(enabled);
        } catch {}
        try {
          property.setLocalAmbientOcclusion?.(enabled);
        } catch {}
      }
      if (mapper) {
        try {
          // Reste sur le mapper en 34.x. >=1 requis (clampé en interne).
          mapper.setVolumeShadowSamplingDistFactor?.(enabled ? 5.0 : 1.0);
        } catch {}
      }
    }
  } catch {
    // Acteur/mapper indisponible — sera ré-appliqué au prochain rendu.
  }
}

/**
 * Rendu SURFACIQUE (« 3D Surface Rendering » de Horos) approximé sur le rendu
 * volumique : on remplace la fonction d'opacité scalaire par un ESCALIER raide
 * au seuil iso (transparent en dessous, opaque au-dessus) → l'iso-surface
 * apparaît, l'ombrage déjà actif lui donne le relief. Réversible : `enabled=false`
 * laisse le preset reprendre la main (ré-appliqué par l'appelant). Best-effort.
 */
function applySurface(vp: any, isoValue: number, enabled: boolean) {
  if (!enabled) return;
  try {
    const actors = vp?.getActors?.();
    if (!actors || !actors.length) return;
    for (const entry of actors) {
      const actor = entry?.actor ?? entry?.volumeActor ?? entry;
      const property = actor?.getProperty?.();
      const ofun = property?.getScalarOpacity?.(0);
      if (!ofun) continue;
      ofun.removeAllPoints?.();
      ofun.addPoint?.(isoValue - 1, 0.0);
      ofun.addPoint?.(isoValue, 0.85);
      ofun.addPoint?.(isoValue + 2000, 0.95);
      // Surface nette : ombrage ON, opacité de gradient OFF (sinon halo diffus).
      property.setShade?.(true);
      property.setUseGradientOpacity?.(0, false);
    }
    vp?.render?.();
  } catch {
    // Acteur pas prêt — ré-appliqué au prochain applyPreset.
  }
}

export default function VolumeViewer({
  imageUrls,
  orthancImageIds,
  volumeId,
  mode,
  slabThicknessMm,
  slabMode,
  preset3d,
  realistic3d = true,
  surface3d = false,
  surfaceIso = 300,
  flyThruNonce = 0,
  turntableNonce = 0,
  cropFraction = 0,
  petImageUrls,
  petVolumeId,
  fusionOpacity = 0.5,
  petColormapId = DEFAULT_PET_COLORMAP_ID,
}: VolumeViewerProps) {
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const obliqueRef = useRef<HTMLDivElement>(null);
  const vr3dRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<any>(null);
  // Module @cornerstonejs/tools capturé au setup pour un teardown SYNCHRONE dans
  // le cleanup (l'ordre de destruction est critique, cf. cleanup ci-dessous).
  const csToolsRef = useRef<any>(null);
  // Dernière valeur de realistic3d lisible dans applyPreset (effet principal)
  // sans le mettre dans ses deps (sinon le toggle reconstruirait le moteur).
  const realistic3dRef = useRef<boolean>(realistic3d);
  realistic3dRef.current = realistic3d;
  // Mode surface + seuil iso, lisibles dans applyPreset sans reconstruire le moteur.
  const surface3dRef = useRef<boolean>(surface3d);
  surface3dRef.current = surface3d;
  const surfaceIsoRef = useRef<number>(surfaceIso);
  surfaceIsoRef.current = surfaceIso;
  // Liste des viewportIds portant le volume PET (renseignée au setup) + id du
  // volume PET effectivement chargé : utilisés par l'effet « fusion » qui ajuste
  // opacité/colormap SANS reconstruire le moteur.
  const fusionViewportIdsRef = useRef<string[]>([]);
  const loadedPetVolumeIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-rend le volume quand la zone d'affichage change de taille (ouverture du
  // panneau « Compte rendu », redimensionnement de la fenêtre…). Sans cela, les
  // viewports MPR/3D restent figés à leur taille initiale → quadrants noirs ou
  // rayés (« problème de chargement »).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          engineRef.current?.resize(true, false);
        } catch {}
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      setLoading(true);
      setError(null);
      try {
        const cornerstone = await import("@cornerstonejs/core");
        const { RenderingEngine, Enums, volumeLoader, setVolumesForViewports } =
          cornerstone as any;

        // Make sure core is initialized (idempotent).
        if (!cornerstone.getRenderingEngine?.(VOLUME_ENGINE_ID)) {
          await cornerstone.init?.();
        }

        // Source priority: orthancImageIds (wadors) > imageUrls (wadouri)
        const imageIds =
          orthancImageIds && orthancImageIds.length
            ? orthancImageIds
            : (imageUrls ?? []).map(u => `wadouri:${u}`);

        if (imageIds.length < 2) {
          throw new Error("Need at least 2 slices to build a volume");
        }

        const volId = volumeId ?? `cornerstoneStreamingImageVolume:HOROS_VOL`;

        // Drop any cached volume from a previous mount so we rebuild cleanly.
        try {
          cornerstone.cache?.removeVolumeLoadObject?.(volId);
        } catch {}
        const volume = await volumeLoader.createAndCacheVolume(volId, {
          imageIds,
        });

        // ── Fusion PET-CT (additif, fail-safe) ──────────────────────────────
        // Construit le volume PET si des coupes PET sont fournies (≥ 2). Tout
        // échec est silencieux : la fusion est un PLUS, jamais un bloqueur du
        // rendu CT/MPR/3D. addPetFusion() ajoute ensuite le volume aux viewports
        // déjà initialisés et applique colormap + opacité.
        const petIds = (petImageUrls ?? []).map(u => `wadouri:${u}`);
        const petVolId = petVolumeId ?? PET_VOLUME_ID_DEFAULT;
        let petVolume: any = null;
        loadedPetVolumeIdRef.current = null;
        fusionViewportIdsRef.current = [];
        if (petIds.length >= 2) {
          try {
            cornerstone.cache?.removeVolumeLoadObject?.(petVolId);
          } catch {}
          try {
            petVolume = await volumeLoader.createAndCacheVolume(petVolId, {
              imageIds: petIds,
            });
          } catch (e) {
            console.warn(
              "[VolumeViewer] PET volume load failed (fusion off):",
              e
            );
            petVolume = null;
          }
        }

        // Ajoute le volume PET (s'il existe) aux viewports fournis, applique sa
        // colormap + opacité, puis le charge en arrière-plan. Fail-safe complet.
        const addPetFusion = async (viewportIds: string[]) => {
          if (!petVolume) return;
          try {
            const addVolumes =
              (cornerstone as any).addVolumesToViewports ??
              (cornerstone as any).default?.addVolumesToViewports;
            if (typeof addVolumes !== "function") return;
            await addVolumes(engine, [{ volumeId: petVolId }], viewportIds);
            loadedPetVolumeIdRef.current = petVolId;
            fusionViewportIdsRef.current = viewportIds;
            applyPetFusionProps(
              engine,
              viewportIds,
              petVolId,
              petColormapId,
              fusionOpacity
            );
            petVolume.load?.(() => {
              applyPetFusionProps(
                engine,
                viewportIds,
                petVolId,
                petColormapId,
                fusionOpacity
              );
            });
          } catch (e) {
            console.warn("[VolumeViewer] PET fusion overlay failed:", e);
          }
        };

        // Fresh engine each time.
        if (engineRef.current) {
          try {
            engineRef.current.destroy();
          } catch {}
        }
        const engine = new RenderingEngine(VOLUME_ENGINE_ID);
        engineRef.current = engine;

        if (cancelled) return;

        if (mode === "mpr") {
          // ── Init @cornerstonejs/tools ────────────────────────────────────
          const csTools = await import("@cornerstonejs/tools");
          const {
            init: toolsInit,
            ToolGroupManager,
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
            Enums: csToolsEnums,
            addTool,
            synchronizers,
          } = csTools as any;
          // Capturer le module pour un teardown synchrone et ordonné au cleanup.
          csToolsRef.current = csTools;

          await toolsInit();
          for (const t of [
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
          ]) {
            try {
              addTool(t);
            } catch {} // addTool throws if already registered — ignore
          }

          // ── 4 viewports : axial / sagittal / coronal / oblique ───────────
          const inputs = [
            {
              viewportId: "MPR_AXIAL",
              element: axialRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
            },
            {
              viewportId: "MPR_SAGITTAL",
              element: sagittalRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL },
            },
            {
              viewportId: "MPR_CORONAL",
              element: coronalRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: { orientation: Enums.OrientationAxis.CORONAL },
            },
            {
              viewportId: "MPR_OBLIQUE",
              element: obliqueRef.current!,
              type: Enums.ViewportType.ORTHOGRAPHIC,
              defaultOptions: {
                orientation: Enums.OrientationAxis.ACQUISITION,
              },
            },
          ];
          engine.setViewports(inputs);

          const allIds = [
            "MPR_AXIAL",
            "MPR_SAGITTAL",
            "MPR_CORONAL",
            "MPR_OBLIQUE",
          ];
          await setVolumesForViewports(engine, [{ volumeId: volId }], allIds);

          // Fusion PET-CT : superpose le volume PET coloré sur les 4 vues MPR.
          await addPetFusion(allIds);

          // ── ToolGroup ─────────────────────────────────────────────────────
          const TOOLGROUP_ID = "HOROS_MPR_TG";
          ToolGroupManager.destroyToolGroup?.(TOOLGROUP_ID);
          const tg = ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
          for (const t of [
            CrosshairsTool,
            WindowLevelTool,
            StackScrollTool,
            PanTool,
            ZoomTool,
          ]) {
            tg.addTool(t.toolName);
          }
          allIds.forEach((id: string) => tg.addViewport(id, VOLUME_ENGINE_ID));

          const { MouseBindings } = csToolsEnums;
          tg.setToolActive(CrosshairsTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Primary }],
          });
          tg.setToolActive(WindowLevelTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Secondary }],
          });
          tg.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Auxiliary }],
          });
          tg.setToolActive(StackScrollTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Wheel }],
          });

          // ── VOI Synchronizer (W/L cohérent sur les 4 vues) ───────────────
          // Détruire un éventuel synchroniseur résiduel AVANT de recréer : le
          // cleanup du démontage précédent le détruit de façon asynchrone (via
          // import().then()), donc quand l'effet se relance (nouvelle réf de
          // imageUrls, changement de mode/slab…) le create peut précéder ce
          // destroy → "Synchronizer already exists" → setup MPR avorté → écran
          // noir. On garantit ici l'unicité, comme le destroyToolGroup défensif.
          try {
            (csTools as any).SynchronizerManager?.destroySynchronizer?.(
              "HOROS_VOI_SYNC"
            );
          } catch {}
          const voiSync = synchronizers.createVOISynchronizer(
            "HOROS_VOI_SYNC",
            { syncInvertState: false, syncColormap: false }
          );
          allIds.forEach((id: string) =>
            voiSync.add({ renderingEngineId: VOLUME_ENGINE_ID, viewportId: id })
          );

          // ── W/L par défaut (CT soft-tissue) ──────────────────────────────
          const applyMprWindow = () => {
            for (const id of allIds) {
              try {
                engine
                  .getViewport(id)
                  .setProperties({ voiRange: { lower: -160, upper: 240 } });
              } catch {}
            }
            engine.renderViewports(allIds);
          };

          // ── Slab thickness + blend mode ───────────────────────────────────
          const applySlab = () => {
            if (!slabThicknessMm || slabThicknessMm <= 0) return;
            const blendKey = slabModeToBlend(slabMode ?? "mip");
            // BlendModes est dans Enums du core (pas dans csToolsEnums)
            const blend = (Enums as any).BlendModes?.[blendKey];
            for (const id of allIds) {
              try {
                const vp = engine.getViewport(id) as any;
                vp.setSlabThickness(slabThicknessMm);
                if (blend !== undefined) vp.setBlendMode(blend);
              } catch {}
            }
            engine.renderViewports(allIds);
          };

          engine.resize(true, false);
          applyMprWindow();
          applySlab();
          volume.load(() => {
            applyMprWindow();
            applySlab();
          });
        } else {
          engine.setViewports([
            {
              viewportId: "VR_3D",
              element: vr3dRef.current!,
              type: Enums.ViewportType.VOLUME_3D,
              defaultOptions: {
                background: [0, 0, 0] as [number, number, number],
              },
            },
          ]);
          await setVolumesForViewports(
            engine,
            [{ volumeId: volId }],
            ["VR_3D"]
          );
          const vp = engine.getViewport("VR_3D") as any;

          // ── Outils d'interaction 3D (rotation/pan/zoom) ──────────────────
          // Init @cornerstonejs/tools (idempotent) + tool group dédié au 3D :
          //   • TrackballRotate sur le bouton PRIMAIRE (rotation au glisser)
          //   • Pan sur le bouton AUXILIAIRE (molette enfoncée / milieu)
          //   • Zoom sur le bouton SECONDAIRE et à la molette
          const csTools3d = await import("@cornerstonejs/tools");
          const {
            init: toolsInit3d,
            ToolGroupManager: TGM3d,
            TrackballRotateTool,
            PanTool: PanTool3d,
            ZoomTool: ZoomTool3d,
            Enums: csEnums3d,
            addTool: addTool3d,
          } = csTools3d as any;
          // Capturer pour un teardown synchrone (cf. cleanup, même logique MPR).
          csToolsRef.current = csTools3d;
          await toolsInit3d();
          for (const t of [TrackballRotateTool, PanTool3d, ZoomTool3d]) {
            try {
              addTool3d(t);
            } catch {} // déjà enregistré — ignorer
          }
          const TG3D_ID = "HOROS_3D_TG";
          try {
            TGM3d.destroyToolGroup?.(TG3D_ID);
          } catch {}
          const tg3d = TGM3d.createToolGroup(TG3D_ID)!;
          for (const t of [TrackballRotateTool, PanTool3d, ZoomTool3d]) {
            tg3d.addTool(t.toolName);
          }
          tg3d.addViewport("VR_3D", VOLUME_ENGINE_ID);
          const { MouseBindings: MB3d } = csEnums3d;
          tg3d.setToolActive(TrackballRotateTool.toolName, {
            bindings: [{ mouseButton: MB3d.Primary }],
          });
          tg3d.setToolActive(PanTool3d.toolName, {
            bindings: [{ mouseButton: MB3d.Auxiliary }],
          });
          tg3d.setToolActive(ZoomTool3d.toolName, {
            bindings: [
              { mouseButton: MB3d.Secondary },
              { mouseButton: MB3d.Wheel },
            ],
          });

          const applyPreset = () => {
            const p = presetParId(preset3d);
            try {
              vp.setBlendMode?.(
                p.mip
                  ? Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
                  : Enums.BlendModes.COMPOSITE
              );
            } catch {}
            try {
              vp.setProperties({ preset: p.preset });
            } catch {}
            // Ombrage APRÈS le preset (le preset peut redéfinir le shading).
            // Désactivé en MIP : la projection max ne tient pas compte du relief.
            if (!p.mip) {
              applyShading(vp);
              // Rendu réaliste cinématique (lecture de la dernière valeur via ref).
              applyCinematic(vp, realistic3dRef.current);
              // Mode surfacique (escalier d'opacité au seuil iso) APRÈS le preset.
              applySurface(vp, surfaceIsoRef.current, surface3dRef.current);
            } else {
              // En MIP : pas de GI, juste neutraliser pour rester rapide.
              applyCinematic(vp, false);
            }
            vp.render();
          };
          engine.resize(true, false);
          applyPreset();
          // Bien cadrer le volume une fois chargé, fond noir déjà réglé.
          volume.load(() => {
            applyPreset();
            try {
              vp.resetCamera?.();
            } catch {}
            vp.render();
          });
        }

        if (!cancelled) setLoading(false);
      } catch (err: any) {
        console.error("[VolumeViewer] setup failed:", err);
        if (!cancelled) {
          setError(err?.message || "Volume rendering failed");
          setLoading(false);
        }
      }
    };

    setup();
    return () => {
      cancelled = true;
      const capturedVolId =
        volumeId ?? `cornerstoneStreamingImageVolume:HOROS_VOL`;
      // ── ORDRE DE TEARDOWN CRITIQUE ───────────────────────────────────────
      // Synchronizer.destroy() et ToolGroup accèdent aux viewports via
      // getRenderingEngine(id).getViewport(id). Si on détruit le moteur AVANT,
      // ces destroy lèvent (viewportsInfo/context undefined), destroySynchronizer
      // n'atteint jamais son splice → le synchroniseur FUIT dans
      // state.synchronizers → "Synchronizer already exists" au prochain create,
      // et ses listeners zombies spamment la console. On détruit donc, de façon
      // SYNCHRONE (module capturé, pas d'import async qui s'ordonnerait après) :
      //   1) synchroniseur  2) toolgroup  3) moteur de rendu — dans cet ordre.
      const csTools = csToolsRef.current;
      try {
        csTools?.SynchronizerManager?.destroySynchronizer?.("HOROS_VOI_SYNC");
      } catch {}
      try {
        csTools?.ToolGroupManager?.destroyToolGroup?.("HOROS_MPR_TG");
      } catch {}
      try {
        csTools?.ToolGroupManager?.destroyToolGroup?.("HOROS_3D_TG");
      } catch {}
      try {
        engineRef.current?.destroy();
      } catch {}
      engineRef.current = null;
      const capturedPetVolId = petVolumeId ?? PET_VOLUME_ID_DEFAULT;
      // Purge des volumes du cache (mémoire GPU) — peut rester asynchrone.
      import("@cornerstonejs/core")
        .then((cs: any) => {
          try {
            cs.cache?.removeVolumeLoadObject?.(capturedVolId);
          } catch {}
          try {
            cs.cache?.removeVolumeLoadObject?.(capturedPetVolId);
          } catch {}
        })
        .catch(() => {});
    };
  }, [
    imageUrls,
    orthancImageIds,
    volumeId,
    mode,
    slabThicknessMm,
    slabMode,
    petImageUrls,
    petVolumeId,
  ]);

  // Changement de preset 3D : ré-appliquer SANS reconstruire le moteur (rapide).
  // `preset3d` est volontairement HORS du tableau de deps du useEffect principal.
  useEffect(() => {
    if (mode !== "3d") return;
    let cancelled = false;
    (async () => {
      const engine = engineRef.current;
      const vp = engine?.getViewport?.("VR_3D");
      if (!vp) return;
      const cs = await import("@cornerstonejs/core");
      if (cancelled) return;
      const p = presetParId(preset3d);
      try {
        vp.setBlendMode?.(
          p.mip
            ? cs.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND
            : cs.Enums.BlendModes.COMPOSITE
        );
      } catch {}
      try {
        vp.setProperties({ preset: p.preset });
      } catch {}
      // Ré-appliquer l'ombrage après le preset (sauf en MIP).
      if (!p.mip) {
        applyShading(vp);
        applyCinematic(vp, realistic3d);
        applySurface(vp, surfaceIsoRef.current, surface3d);
      } else {
        applyCinematic(vp, false);
      }
      vp.render();
    })();
    return () => {
      cancelled = true;
    };
  }, [preset3d, mode, realistic3d, surface3d, surfaceIso]);

  // Fly-thru / endoscopie virtuelle (« 3D Endoscopy » de Horos) : à chaque
  // incrément de flyThruNonce, anime la caméra le long d'un chemin de Catmull-Rom
  // (départ → centre → au-delà), donnant un vol vers l'intérieur du volume, puis
  // restaure la caméra initiale. Best-effort, sans reconstruire le moteur.
  useEffect(() => {
    if (mode !== "3d" || !flyThruNonce) return;
    const vp = engineRef.current?.getViewport?.("VR_3D") as any;
    if (!vp?.getCamera || !vp?.setCamera) return;
    let cancelled = false;
    let raf = 0;
    try {
      const cam0 = vp.getCamera();
      const pos = cam0.position as number[];
      const fp = cam0.focalPoint as number[];
      const up = cam0.viewUp as number[];
      const dx = fp[0] - pos[0];
      const dy = fp[1] - pos[1];
      const dz = fp[2] - pos[2];
      const dist = Math.hypot(dx, dy, dz) || 1;
      const dir = [dx / dist, dy / dist, dz / dist];
      const beyond = [
        fp[0] + dir[0] * dist,
        fp[1] + dir[1] * dist,
        fp[2] + dir[2] * dist,
      ];
      const path = catmullRomSpline([pos as any, fp as any, beyond as any], 30);
      let i = 0;
      const step = () => {
        if (cancelled || i >= path.length) {
          try {
            vp.setCamera(cam0);
            vp.render();
          } catch {}
          return;
        }
        const p = path[i] as number[];
        i++;
        try {
          vp.setCamera({
            position: p,
            focalPoint: [
              p[0] + dir[0] * 10,
              p[1] + dir[1] * 10,
              p[2] + dir[2] * 10,
            ],
            viewUp: up,
          });
          vp.render();
        } catch {}
        raf = requestAnimationFrame(step);
      };
      step();
    } catch {
      /* caméra indisponible — fly-thru ignoré */
    }
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [flyThruNonce, mode]);

  // Export turntable (« vidéo de rotation » du rendu 3D) : à chaque incrément de
  // turntableNonce, on fait orbiter la caméra du viewport VR_3D sur un tour
  // complet en capturant son canvas via MediaRecorder, puis on télécharge le
  // WebM en local. 100 % client : aucun pixel ne quitte le navigateur.
  useEffect(() => {
    if (mode !== "3d" || !turntableNonce) return;
    const vp = engineRef.current?.getViewport?.("VR_3D") as any;
    if (!vp?.getCamera || !vp?.setCamera) return;
    const canvas: HTMLCanvasElement | null =
      vp.getCanvas?.() ?? vr3dRef.current?.querySelector("canvas") ?? null;
    if (
      !canvas ||
      typeof (canvas as any).captureStream !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Export rotation indisponible sur ce navigateur.");
      return;
    }
    let cancelled = false;
    let raf = 0;
    try {
      const cam0 = vp.getCamera();
      const pos0 = cam0.position as number[];
      const fp = cam0.focalPoint as number[];
      const up = cam0.viewUp as number[];
      const FRAMES = 90;
      const FPS = 30;
      const angles = turntableAngles(FRAMES);
      const stream = (canvas as any).captureStream(FPS);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        try {
          const blob = new Blob(chunks, { type: "video/webm" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `rotation-3d-${Date.now()}.webm`;
          a.click();
          URL.revokeObjectURL(a.href);
        } catch {}
      };
      recorder.start();
      let i = 0;
      const step = () => {
        if (cancelled || i >= angles.length) {
          try {
            vp.setCamera(cam0);
            vp.render();
          } catch {}
          try {
            recorder.stop();
          } catch {}
          return;
        }
        try {
          const position = orbitAroundFocalPoint(pos0, fp, up, angles[i]);
          vp.setCamera({ position, focalPoint: fp, viewUp: up });
          vp.render();
        } catch {}
        i++;
        raf = requestAnimationFrame(step);
      };
      step();
    } catch {
      /* caméra/enregistrement indisponible — export ignoré */
    }
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [turntableNonce, mode]);

  // Scissor editing (« Scissor Editing » de Horos) : découpe du volume 3D par
  // des plans de coupe vtk recadrant sur la boîte centrale (fraction retirée de
  // chaque côté). Mécanisme réel de clipping ; 100% try/catch + additif (fraction
  // 0 = aucun plan = volume inchangé) → ne peut pas casser le rendu 3D existant.
  useEffect(() => {
    if (mode !== "3d") return;
    let cancelled = false;
    (async () => {
      try {
        const vp = engineRef.current?.getViewport?.("VR_3D") as any;
        const actors = vp?.getActors?.();
        if (!actors || !actors.length) return;
        const actor = actors[0]?.actor ?? actors[0]?.volumeActor ?? actors[0];
        const mapper = actor?.getMapper?.();
        if (!mapper) return;
        mapper.removeAllClippingPlanes?.();
        if (cropFraction > 0.01) {
          const b = actor.getBounds?.();
          if (b && b.length >= 6) {
            const vtkPlane = (
              await import("@kitware/vtk.js/Common/DataModel/Plane")
            ).default;
            if (cancelled) return;
            const cx = (b[0] + b[1]) / 2;
            const cy = (b[2] + b[3]) / 2;
            const cz = (b[4] + b[5]) / 2;
            const f = Math.min(0.9, cropFraction);
            const hx = ((b[1] - b[0]) / 2) * (1 - f);
            const hy = ((b[3] - b[2]) / 2) * (1 - f);
            const hz = ((b[5] - b[4]) / 2) * (1 - f);
            const planes = [
              { o: [cx - hx, cy, cz], n: [1, 0, 0] },
              { o: [cx + hx, cy, cz], n: [-1, 0, 0] },
              { o: [cx, cy - hy, cz], n: [0, 1, 0] },
              { o: [cx, cy + hy, cz], n: [0, -1, 0] },
              { o: [cx, cy, cz - hz], n: [0, 0, 1] },
              { o: [cx, cy, cz + hz], n: [0, 0, -1] },
            ];
            for (const p of planes) {
              const pl = vtkPlane.newInstance();
              pl.setOrigin(p.o as any);
              pl.setNormal(p.n as any);
              mapper.addClippingPlane?.(pl);
            }
          }
        }
        vp.render?.();
      } catch {
        /* clipping indisponible — scissor ignoré, rendu inchangé */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cropFraction, mode, preset3d, surface3d]);

  // Changement d'opacité / colormap de la fusion PET : ré-appliquer SANS
  // reconstruire le moteur (rapide, glissement de curseur fluide). N'agit que si
  // un volume PET est effectivement chargé sur des viewports (fusionViewportIds).
  useEffect(() => {
    const engine = engineRef.current;
    const petVolId = loadedPetVolumeIdRef.current;
    const viewportIds = fusionViewportIdsRef.current;
    if (!engine || !petVolId || viewportIds.length === 0) return;
    applyPetFusionProps(
      engine,
      viewportIds,
      petVolId,
      petColormapId,
      fusionOpacity
    );
  }, [fusionOpacity, petColormapId]);

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="absolute inset-0 bg-black">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <p className="text-xs text-muted-foreground">
            Building {mode === "mpr" ? "MPR" : "3D"} volume…
          </p>
        </div>
      )}
      {mode === "mpr" ? (
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-border">
          <div
            ref={axialRef}
            className="relative bg-black"
            data-label="Axial"
          />
          <div
            ref={sagittalRef}
            className="relative bg-black"
            data-label="Sagittal"
          />
          <div
            ref={coronalRef}
            className="relative bg-black"
            data-label="Coronal"
          />
          <div
            ref={obliqueRef}
            className="relative bg-black"
            data-label="Oblique"
          />
        </div>
      ) : (
        <div ref={vr3dRef} className="absolute inset-0 bg-black" />
      )}
    </div>
  );
}
