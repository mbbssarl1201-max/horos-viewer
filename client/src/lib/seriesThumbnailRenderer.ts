// Génère une VRAIE vignette (PNG data URL) pour une série en rendant une coupe
// représentative hors écran avec Cornerstone3D.
//
// Contraintes (cf. demande) :
//  - moteur de rendu + élément DÉDIÉS (id séparé) → ne touche jamais le viewport
//    principal, son tool group, son préchargement ni ses annotations ;
//  - un seul petit rendu offscreen à la fois (file d'attente) ; résultats mis en
//    cache par imageId → pas de re-rendu à chaque re-render du panneau ;
//  - asynchrone, non bloquant ; le panneau garde le placeholder noir tant que la
//    vignette n'est pas prête, et y retombe en cas d'échec (séries compressées
//    non décodables, réseau, etc.).

import { initCornerstone } from "@/components/CornerstoneViewer";

// Id dédiés, distincts de ceux du viewer principal (horosRenderingEngine).
const THUMB_ENGINE_ID = "horosThumbnailEngine";
const THUMB_VIEWPORT_ID = "horosThumbnailViewport";
const THUMB_SIZE = 120; // px (carré)

// Cache imageId → data URL (ou null = échec, pour ne pas réessayer en boucle).
const cache = new Map<string, string | null>();
// Promesses en cours, dédupliquées par imageId.
const inflight = new Map<string, Promise<string | null>>();

// Élément hors écran + moteur, créés paresseusement et réutilisés.
let thumbElement: HTMLDivElement | null = null;
let renderingEngine: any = null;
// File d'attente : un rendu à la fois (le moteur n'a qu'un viewport).
let queue: Promise<unknown> = Promise.resolve();

function ensureElement(): HTMLDivElement {
  if (thumbElement) return thumbElement;
  const el = document.createElement("div");
  el.style.width = `${THUMB_SIZE}px`;
  el.style.height = `${THUMB_SIZE}px`;
  // Hors écran mais bien dimensionné (Cornerstone calcule la taille du canvas à
  // partir de l'élément ; un display:none donnerait un canvas 0×0).
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  thumbElement = el;
  return el;
}

/**
 * Rend l'imageId hors écran et renvoie un PNG data URL, ou null si le rendu
 * échoue. Applique le window/level fourni (défauts du viewer ou W/L DICOM).
 * Sérialisé : les appels concurrents sont mis en file pour partager l'unique
 * viewport offscreen.
 */
export function renderThumbnail(
  imageId: string,
  windowWidth: number,
  windowCenter: number
): Promise<string | null> {
  if (cache.has(imageId)) return Promise.resolve(cache.get(imageId)!);
  const existing = inflight.get(imageId);
  if (existing) return existing;

  const task = queue
    .catch(() => undefined) // un échec précédent ne doit pas bloquer la file
    .then(() => renderOne(imageId, windowWidth, windowCenter))
    .then(dataUrl => {
      cache.set(imageId, dataUrl);
      inflight.delete(imageId);
      return dataUrl;
    })
    .catch(() => {
      cache.set(imageId, null);
      inflight.delete(imageId);
      return null;
    });

  inflight.set(imageId, task);
  queue = task;
  return task;
}

async function renderOne(
  imageId: string,
  windowWidth: number,
  windowCenter: number
): Promise<string | null> {
  await initCornerstone();
  const cornerstone = await import("@cornerstonejs/core");
  const { RenderingEngine, Enums } = cornerstone;

  const element = ensureElement();
  if (!renderingEngine) {
    renderingEngine = new RenderingEngine(THUMB_ENGINE_ID);
    renderingEngine.enableElement({
      viewportId: THUMB_VIEWPORT_ID,
      type: Enums.ViewportType.STACK,
      element,
    });
  }

  const viewport = renderingEngine.getViewport(THUMB_VIEWPORT_ID) as any;

  // Attend le premier rendu effectif de l'image avant de lire le canvas (sinon
  // on capturerait un canvas encore vide).
  const rendered = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("thumbnail render timeout"));
    }, 15000);
    const onRendered = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      window.clearTimeout(timeout);
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, onRendered);
    }
    element.addEventListener(Enums.Events.IMAGE_RENDERED, onRendered);
  });

  await viewport.setStack([imageId], 0);
  renderingEngine.resize(true, true);
  viewport.setProperties({
    voiRange: {
      lower: windowCenter - windowWidth / 2,
      upper: windowCenter + windowWidth / 2,
    },
  });
  viewport.render();

  await rendered;

  const canvas = viewport.getCanvas() as HTMLCanvasElement;
  return canvas.toDataURL("image/png");
}
