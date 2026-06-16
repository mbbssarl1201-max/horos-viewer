export type SlabMode = "mip" | "minip" | "average";

/** Clés de Enums.BlendModes (Cornerstone3D). On garde la chaîne pour tester sans importer le moteur. */
const BLEND_KEY: Record<SlabMode, string> = {
  mip: "MAXIMUM_INTENSITY_BLEND",
  minip: "MINIMUM_INTENSITY_BLEND",
  average: "AVERAGE_INTENSITY_BLEND",
};

export const SLAB_MODES: { id: SlabMode; label: string }[] = [
  { id: "mip", label: "MIP" },
  { id: "minip", label: "MinIP" },
  { id: "average", label: "Moyenne" },
];

export function slabModeToBlend(mode: SlabMode): string {
  return BLEND_KEY[mode];
}
