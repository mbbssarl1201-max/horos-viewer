// Carte de raccourcis clavier CONFIGURABLE (préférences « HotKeys »).
//
// À la différence de `keyboardShortcuts.ts` (mapping figé touche → action), ce
// module modélise une carte que l'utilisateur peut RECONFIGURER depuis les
// préférences : chaque action est associée à un « combo » (ex. « Ctrl+Shift+R »,
// « ArrowRight », « k »). On expose des fonctions PURES pour :
//   • parser un combo textuel en sa forme normalisée (`parseCombo`),
//   • résoudre un évènement clavier en action selon la carte (`matchEvent`),
//   • réaffecter un combo à une action (`setHotkey`), avec dé-doublonnage.
//
// PURETÉ : aucun import React/DOM/Cornerstone, aucune I/O. On ne manipule que
// des chaînes et des objets simples → testable hors navigateur. L'évènement est
// passé sous forme d'un objet minimal `KeyEventLike`, pas un `KeyboardEvent`.

/** Identifiants d'actions raccourciables du visualiseur. */
export type HotkeyAction =
  | "resetView"
  | "keyImage"
  | "nextSeries"
  | "prevSeries"
  | "nextSlice"
  | "prevSlice"
  | "toggleInvert"
  | "toggleCine"
  | "zoomIn"
  | "zoomOut"
  | "fullscreen"
  | "screenshot";

/** Carte action → combo (chaîne telle que saisie/affichée dans les préférences). */
export type HotkeyMap = Record<HotkeyAction, string>;

/**
 * Carte par défaut. Les touches simples (lettres) sont sans modificateur ; la
 * navigation utilise les flèches ; les actions « lourdes » (plein écran,
 * capture) portent un modificateur pour éviter les déclenchements accidentels.
 */
export const DEFAULT_HOTKEYS: HotkeyMap = {
  resetView: "r",
  keyImage: "k",
  nextSeries: "ArrowRight",
  prevSeries: "ArrowLeft",
  nextSlice: "ArrowDown",
  prevSlice: "ArrowUp",
  toggleInvert: "i",
  toggleCine: "c",
  zoomIn: "+",
  zoomOut: "-",
  fullscreen: "Shift+f",
  screenshot: "Ctrl+Shift+s",
};

/** Combo normalisé : modificateurs booléens + touche « canonique ». */
export interface ParsedCombo {
  /** Ctrl OU Cmd (Meta) : on les traite comme un seul modificateur « primaire ». */
  ctrlOrMeta: boolean;
  shift: boolean;
  alt: boolean;
  /**
   * Touche principale en forme canonique. Pour une lettre : minuscule (`"r"`).
   * Pour une touche nommée : casse d'origine reconnue (`"ArrowRight"`, `"Enter"`,
   * `"Escape"`, `"Space"`…). Chaîne vide si aucune touche réelle (combo invalide).
   */
  key: string;
}

/** Évènement clavier minimal (sous-ensemble de KeyboardEvent), pour tester sans DOM. */
export interface KeyEventLike {
  /** `KeyboardEvent.key` (ex. « r », « ArrowRight », « + », «  » pour Space). */
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Table de synonymes de touches nommées → forme canonique. On accepte les
 * variantes saisies à la main (« esc », « space », « up »…) et la forme native
 * `KeyboardEvent.key` (« Escape », « ArrowUp »…). Clé de recherche en minuscule.
 */
const NAMED_KEYS: Record<string, string> = {
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Jetons reconnus comme modificateurs (en minuscule). */
const MOD_TOKENS = new Set([
  "ctrl",
  "control",
  "cmd",
  "command",
  "meta",
  "super",
  "win",
  "shift",
  "alt",
  "option",
]);

/**
 * Normalise une touche unique (déjà séparée des modificateurs) vers sa forme
 * canonique. Lettres/chiffres/symboles → minuscule mono-caractère ; touches
 * nommées → via `NAMED_KEYS`. Renvoie `""` si rien d'exploitable.
 */
function canonicalKey(token: string): string {
  const t = token.trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  // Une touche nommée native non listée (ex. « F5 ») : on garde telle quelle si
  // elle fait plus d'un caractère, sinon on minuscule le caractère unique.
  if (t.length === 1) return lower;
  return t;
}

/**
 * Parse un combo textuel (« Ctrl+Shift+R », « ArrowRight », « + ») en
 * `ParsedCombo`. Séparateur « + » ; un « + » isolé est compris comme la touche
 * « + » (utile pour le zoom). Tolère espaces et casse. Ctrl et Cmd/Meta sont
 * fusionnés en `ctrlOrMeta`. Combo sans touche réelle → `key: ""`.
 */
export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = {
    ctrlOrMeta: false,
    shift: false,
    alt: false,
    key: "",
  };
  if (combo === null || combo === undefined) return out;

  // Découpe sur « + » MAIS un « + » qui est la touche elle-même doit survivre.
  // Stratégie : si la chaîne se termine par « + » (ou est « + »), on isole ce
  // dernier « + » comme touche, puis on découpe le préfixe.
  const raw = String(combo).trim();
  if (!raw) return out;

  let keyToken = "";
  let modPart = raw;

  // Cas « ...+ » : le dernier caractère « + » est la touche.
  if (raw.endsWith("+")) {
    keyToken = "+";
    modPart = raw.slice(0, -1); // peut finir par « + » séparateur, ex. « Ctrl++ »
    if (modPart.endsWith("+")) modPart = modPart.slice(0, -1);
  }

  const tokens = modPart
    .split("+")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (MOD_TOKENS.has(lower)) {
      if (lower === "shift") out.shift = true;
      else if (lower === "alt" || lower === "option") out.alt = true;
      else out.ctrlOrMeta = true; // ctrl/control/cmd/command/meta/super/win
    } else {
      // Dernier jeton non-modificateur = touche principale.
      keyToken = tok;
    }
  }

  out.key = canonicalKey(keyToken);
  return out;
}

/**
 * Normalise la touche d'un `KeyEventLike` (forme `KeyboardEvent.key`) vers la
 * même forme canonique que `parseCombo`. Notamment : l'espace est `" "` dans
 * `KeyboardEvent.key` → on le mappe sur « Space ».
 */
function canonicalEventKey(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  return canonicalKey(key);
}

/**
 * Résout un évènement clavier en action selon la carte fournie. Renvoie la
 * PREMIÈRE action dont le combo correspond exactement (touche canonique +
 * modificateurs identiques), ou `null` si aucune. Comparaison de touche
 * insensible à la casse pour les lettres (via la forme canonique).
 *
 * Un combo non parsable (touche vide) dans la carte n'est jamais déclenché.
 */
export function matchEvent(
  hotkeys: HotkeyMap,
  ev: KeyEventLike
): HotkeyAction | null {
  const evKey = canonicalEventKey(ev.key ?? "");
  if (!evKey) return null;
  const evCtrlOrMeta = Boolean(ev.ctrl) || Boolean(ev.meta);
  const evShift = Boolean(ev.shift);
  const evAlt = Boolean(ev.alt);

  for (const action of Object.keys(hotkeys) as HotkeyAction[]) {
    const c = parseCombo(hotkeys[action]);
    if (!c.key) continue;
    if (
      c.key === evKey &&
      c.ctrlOrMeta === evCtrlOrMeta &&
      c.shift === evShift &&
      c.alt === evAlt
    ) {
      return action;
    }
  }
  return null;
}

/**
 * Renvoie une NOUVELLE carte où `action` est associée à `combo`. Si ce combo
 * (sous sa forme normalisée) était déjà affecté à une AUTRE action, l'ancienne
 * affectation est vidée (`""`) pour éviter deux actions sur la même frappe —
 * la dernière affectation gagne. Carte d'entrée jamais mutée.
 *
 * Un `combo` vide/non parsable est accepté tel quel (sert à « désaffecter »).
 */
export function setHotkey(
  map: HotkeyMap,
  action: HotkeyAction,
  combo: string
): HotkeyMap {
  const next: HotkeyMap = { ...map };
  const parsed = parseCombo(combo);

  // Dé-doublonnage : si le nouveau combo est non vide, on vide toute autre
  // action qui résolvait au même combo normalisé.
  if (parsed.key) {
    for (const other of Object.keys(next) as HotkeyAction[]) {
      if (other === action) continue;
      const oc = parseCombo(next[other]);
      if (
        oc.key === parsed.key &&
        oc.ctrlOrMeta === parsed.ctrlOrMeta &&
        oc.shift === parsed.shift &&
        oc.alt === parsed.alt
      ) {
        next[other] = "";
      }
    }
  }

  next[action] = combo;
  return next;
}
