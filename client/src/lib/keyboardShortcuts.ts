// Mapping pur touche → action pour les raccourcis clavier du visualiseur.
// La logique d'effet (changer de coupe, d'outil…) reste dans Viewer.tsx ;
// ici on ne fait que résoudre un évènement clavier en identifiant d'action.

/** Actions déclenchables au clavier. */
export type ShortcutAction =
  | { kind: "prevSlice" }
  | { kind: "nextSlice" }
  | { kind: "firstSlice" }
  | { kind: "lastSlice" }
  | { kind: "tool"; tool: string }
  | { kind: "preset"; index: number } // index dans les W/L presets (0-based)
  | { kind: "cineToggle" };

/** Une entrée de légende affichable dans l'aide. */
export interface ShortcutHelp {
  keys: string;
  label: string;
}

// Touches → outil (minuscules ; on compare en minuscule). On évite les touches
// qui entrent en conflit avec le navigateur (Ctrl/Cmd gérés en amont).
const TOOL_KEYS: Record<string, string> = {
  w: "wwwl",
  z: "zoom",
  p: "pan",
  s: "scroll",
  l: "length",
  a: "angle",
  e: "ellipse",
  r: "rect",
  t: "text",
};

/**
 * Résout un évènement clavier en action, ou null si la touche n'est pas mappée.
 * Ignore les combinaisons avec Ctrl/Meta/Alt pour ne pas voler les raccourcis
 * navigateur/OS. Les chiffres 1..N sélectionnent les presets W/L.
 */
export function resolveShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  presetCount: number
): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  switch (e.key) {
    case "ArrowUp":
    case "PageUp":
      return { kind: "prevSlice" };
    case "ArrowDown":
    case "PageDown":
      return { kind: "nextSlice" };
    case "Home":
      return { kind: "firstSlice" };
    case "End":
      return { kind: "lastSlice" };
    case " ":
    case "Spacebar": // anciens navigateurs
      return { kind: "cineToggle" };
  }

  // Chiffres 1..N → presets W/L.
  if (/^[0-9]$/.test(e.key)) {
    const index = parseInt(e.key, 10) - 1;
    if (index >= 0 && index < presetCount) return { kind: "preset", index };
    return null;
  }

  // Lettres → outils.
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) return { kind: "tool", tool };

  return null;
}

/** Légende des raccourcis pour l'aide (français). */
export function shortcutLegend(presetCount: number): ShortcutHelp[] {
  return [
    { keys: "↑ / Page préc.", label: "Coupe précédente" },
    { keys: "↓ / Page suiv.", label: "Coupe suivante" },
    { keys: "Début / Fin", label: "Première / dernière coupe" },
    { keys: "Espace", label: "Lecture / pause du ciné" },
    { keys: "W", label: "Outil Fenêtrage (W/L)" },
    { keys: "Z", label: "Outil Zoom" },
    { keys: "P", label: "Outil Déplacement (Pan)" },
    { keys: "S", label: "Outil Défilement" },
    { keys: "L", label: "Mesure de longueur" },
    { keys: "A", label: "Mesure d'angle" },
    { keys: "E", label: "ROI ellipse" },
    { keys: "R", label: "ROI rectangle" },
    { keys: "T", label: "Annotation texte" },
    {
      keys: `1 – ${presetCount}`,
      label: "Presets de fenêtrage (W/L)",
    },
  ];
}
