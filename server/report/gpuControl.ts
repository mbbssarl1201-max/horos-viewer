import { ENV } from "../_core/env";

/**
 * Client du sidecar `gpu-control` (plan de contrôle du GPU vision).
 *
 * Le GPU vision (Infomaniak L4) est mis en veille (shelve) quand il est inactif
 * pour ne facturer qu'à l'usage ; ce module permet à MediView d'interroger son
 * état, de le réveiller (bouton « Réveiller l'IA »), et de signaler une activité
 * (touch) pour réarmer le minuteur d'inactivité à chaque compte rendu.
 *
 * Si `GPU_CONTROL_URL` n'est pas configuré, la fonctionnalité est désactivée :
 * le statut renvoie "unknown" et les actions sont des no-op (le GPU est alors
 * supposé toujours disponible — comportement historique).
 */
export type GpuState =
  | "ready" // GPU actif + modèle vision joignable
  | "starting" // GPU actif mais modèle pas encore prêt
  | "waking" // réveil en cours (unshelve)
  | "asleep" // en veille (shelve) — à réveiller
  | "unknown"; // pilotage non configuré

export interface GpuStatus {
  state: GpuState;
  gpu?: string;
  ready?: boolean;
  idleSeconds?: number;
}

async function call(path: string, method: "GET" | "POST"): Promise<any | null> {
  if (!ENV.gpuControlUrl) return null;
  const resp = await fetch(`${ENV.gpuControlUrl}${path}`, {
    method,
    headers: { "X-GPU-Token": ENV.gpuControlToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`gpu-control HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function gpuStatus(): Promise<GpuStatus> {
  if (!ENV.gpuControlUrl) return { state: "unknown" };
  try {
    const d = await call("/status", "GET");
    return d as GpuStatus;
  } catch {
    // Sidecar injoignable : on n'empêche pas l'usage, on signale juste l'inconnu.
    return { state: "unknown" };
  }
}

export async function gpuWake(): Promise<GpuStatus> {
  if (!ENV.gpuControlUrl) return { state: "unknown" };
  const d = await call("/wake", "POST");
  return d as GpuStatus;
}

/** Réarme le minuteur d'inactivité. Best-effort : n'échoue jamais bruyamment. */
export async function gpuTouch(): Promise<void> {
  if (!ENV.gpuControlUrl) return;
  try {
    await call("/touch", "POST");
  } catch {
    /* best-effort */
  }
}
