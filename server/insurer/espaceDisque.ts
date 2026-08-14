// Sonde d'espace disque libre (octets) du volume qui héberge le stockage.
// Isolée pour rester mockable dans les tests de l'endpoint de rapatriement.
import { statfs } from "fs/promises";

/**
 * Espace libre en octets sur le volume contenant `chemin` (défaut : racine).
 * Renvoie 0 si la mesure échoue — fail-safe : traité comme « disque plein »,
 * donc le rapatriement se suspend plutôt que de risquer une saturation.
 */
export async function espaceLibreOctets(chemin = "/"): Promise<number> {
  try {
    const s = await statfs(chemin);
    return s.bsize * s.bavail;
  } catch {
    return 0;
  }
}
