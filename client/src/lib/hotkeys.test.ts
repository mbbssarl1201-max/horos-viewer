import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOTKEYS,
  parseCombo,
  matchEvent,
  setHotkey,
  type HotkeyMap,
  type KeyEventLike,
} from "./hotkeys";

describe("DEFAULT_HOTKEYS", () => {
  it("contient les actions attendues avec leurs combos", () => {
    expect(DEFAULT_HOTKEYS.resetView).toBe("r");
    expect(DEFAULT_HOTKEYS.keyImage).toBe("k");
    expect(DEFAULT_HOTKEYS.nextSeries).toBe("ArrowRight");
    expect(DEFAULT_HOTKEYS.prevSeries).toBe("ArrowLeft");
  });

  it("couvre 12 actions et aucun combo en double", () => {
    const actions = Object.keys(DEFAULT_HOTKEYS);
    expect(actions).toHaveLength(12);
    const combos = Object.values(DEFAULT_HOTKEYS).map(c =>
      JSON.stringify(parseCombo(c))
    );
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("chaque combo par défaut est parsable (touche non vide)", () => {
    for (const combo of Object.values(DEFAULT_HOTKEYS)) {
      expect(parseCombo(combo).key).not.toBe("");
    }
  });
});

describe("parseCombo", () => {
  it("parse une lettre simple en minuscule sans modificateur", () => {
    expect(parseCombo("r")).toEqual({
      ctrlOrMeta: false,
      shift: false,
      alt: false,
      key: "r",
    });
  });

  it("met en minuscule une lettre majuscule", () => {
    expect(parseCombo("K").key).toBe("k");
  });

  it("parse les modificateurs Ctrl/Shift et la touche", () => {
    expect(parseCombo("Ctrl+Shift+R")).toEqual({
      ctrlOrMeta: true,
      shift: true,
      alt: false,
      key: "r",
    });
  });

  it("parse Alt en plus des autres modificateurs", () => {
    expect(parseCombo("Ctrl+Alt+Shift+d")).toEqual({
      ctrlOrMeta: true,
      shift: true,
      alt: true,
      key: "d",
    });
  });

  it("fusionne Cmd/Command/Meta/Super/Win dans ctrlOrMeta", () => {
    for (const m of ["Cmd", "Command", "Meta", "Super", "Win", "Control"]) {
      const p = parseCombo(`${m}+s`);
      expect(p.ctrlOrMeta).toBe(true);
      expect(p.key).toBe("s");
    }
  });

  it("traite Option comme Alt", () => {
    expect(parseCombo("Option+a").alt).toBe(true);
  });

  it("reconnaît les flèches (natives et synonymes)", () => {
    expect(parseCombo("ArrowRight").key).toBe("ArrowRight");
    expect(parseCombo("right").key).toBe("ArrowRight");
    expect(parseCombo("Left").key).toBe("ArrowLeft");
    expect(parseCombo("up").key).toBe("ArrowUp");
    expect(parseCombo("DOWN").key).toBe("ArrowDown");
  });

  it("reconnaît Escape/Enter/Space et leurs synonymes", () => {
    expect(parseCombo("esc").key).toBe("Escape");
    expect(parseCombo("Escape").key).toBe("Escape");
    expect(parseCombo("return").key).toBe("Enter");
    expect(parseCombo("space").key).toBe("Space");
    expect(parseCombo("spacebar").key).toBe("Space");
  });

  it("gère « + » seul comme la touche plus", () => {
    expect(parseCombo("+")).toEqual({
      ctrlOrMeta: false,
      shift: false,
      alt: false,
      key: "+",
    });
  });

  it("gère « Ctrl++ » : modificateur + touche plus", () => {
    const p = parseCombo("Ctrl++");
    expect(p.ctrlOrMeta).toBe(true);
    expect(p.key).toBe("+");
  });

  it("gère « - » comme touche moins", () => {
    expect(parseCombo("-").key).toBe("-");
  });

  it("tolère les espaces autour des jetons", () => {
    expect(parseCombo("  Ctrl + Shift + s ")).toEqual({
      ctrlOrMeta: true,
      shift: true,
      alt: false,
      key: "s",
    });
  });

  it("le dernier jeton non-modificateur l'emporte comme touche", () => {
    expect(parseCombo("Ctrl+a+b").key).toBe("b");
  });

  it("conserve une touche nommée multi-caractères non listée (F5)", () => {
    expect(parseCombo("F5").key).toBe("F5");
  });

  it("dégénéré : chaîne vide → touche vide", () => {
    expect(parseCombo("").key).toBe("");
  });

  it("dégénéré : que des modificateurs → touche vide", () => {
    expect(parseCombo("Ctrl+Shift").key).toBe("");
  });

  it("dégénéré : valeurs nullish ne lèvent pas et rendent touche vide", () => {
    // @ts-expect-error test d'entrée nullish
    expect(parseCombo(null).key).toBe("");
    // @ts-expect-error test d'entrée nullish
    expect(parseCombo(undefined).key).toBe("");
  });
});

describe("matchEvent", () => {
  const ev = (over: Partial<KeyEventLike> & { key: string }): KeyEventLike =>
    over;

  it("résout une lettre simple", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "r" }))).toBe("resetView");
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "k" }))).toBe("keyImage");
  });

  it("résout insensible à la casse de l'évènement", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "R" }))).toBe("resetView");
  });

  it("résout les flèches", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "ArrowRight" }))).toBe(
      "nextSeries"
    );
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "ArrowUp" }))).toBe(
      "prevSlice"
    );
  });

  it("exige les modificateurs exacts (Shift+f)", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "f", shift: true }))).toBe(
      "fullscreen"
    );
    // sans Shift → pas de correspondance (f seul n'est pas mappé)
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "f" }))).toBeNull();
  });

  it("traite ctrl et meta comme équivalents pour le combo primaire", () => {
    expect(
      matchEvent(DEFAULT_HOTKEYS, ev({ key: "s", ctrl: true, shift: true }))
    ).toBe("screenshot");
    expect(
      matchEvent(DEFAULT_HOTKEYS, ev({ key: "s", meta: true, shift: true }))
    ).toBe("screenshot");
  });

  it("ne déclenche pas si un modificateur surnuméraire est pressé", () => {
    // resetView = « r » sans modificateur ; ici Ctrl+r ne doit pas matcher.
    expect(
      matchEvent(DEFAULT_HOTKEYS, ev({ key: "r", ctrl: true }))
    ).toBeNull();
  });

  it('résout la touche Space (key = " ")', () => {
    const map = setHotkey(DEFAULT_HOTKEYS, "toggleCine", "Space");
    expect(matchEvent(map, ev({ key: " " }))).toBe("toggleCine");
  });

  it("résout « + » et « - »", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "+" }))).toBe("zoomIn");
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "-" }))).toBe("zoomOut");
  });

  it("renvoie null pour une touche non mappée", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "q" }))).toBeNull();
  });

  it("renvoie null pour une touche d'évènement vide", () => {
    expect(matchEvent(DEFAULT_HOTKEYS, ev({ key: "" }))).toBeNull();
  });

  it("ignore une entrée de carte au combo non parsable", () => {
    const map: HotkeyMap = { ...DEFAULT_HOTKEYS, keyImage: "" };
    // « k » n'est plus mappé → null
    expect(matchEvent(map, ev({ key: "k" }))).toBeNull();
  });

  it("renvoie la première action en cas de combos identiques dans la carte", () => {
    // Carte volontairement dupliquée (contournement de setHotkey).
    const map: HotkeyMap = { ...DEFAULT_HOTKEYS, toggleInvert: "r" };
    // resetView vient avant toggleInvert dans l'ordre des clés.
    expect(matchEvent(map, ev({ key: "r" }))).toBe("resetView");
  });
});

describe("setHotkey", () => {
  it("affecte un nouveau combo à une action sans muter l'entrée", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "resetView", "x");
    expect(next.resetView).toBe("x");
    expect(DEFAULT_HOTKEYS.resetView).toBe("r"); // immuable
  });

  it("renvoie une nouvelle référence", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "keyImage", "j");
    expect(next).not.toBe(DEFAULT_HOTKEYS);
  });

  it("vide l'ancienne action en cas de collision de combo", () => {
    // On affecte « r » (déjà = resetView) à keyImage → resetView est vidé.
    const next = setHotkey(DEFAULT_HOTKEYS, "keyImage", "r");
    expect(next.keyImage).toBe("r");
    expect(next.resetView).toBe("");
  });

  it("la collision est détectée sur la forme normalisée (casse/espaces)", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "keyImage", "  R  ");
    expect(next.resetView).toBe("");
    expect(next.keyImage).toBe("  R  ");
  });

  it("la collision tient compte des modificateurs (pas de faux positif)", () => {
    // « Ctrl+r » ne collisionne pas avec « r » (resetView).
    const next = setHotkey(DEFAULT_HOTKEYS, "keyImage", "Ctrl+r");
    expect(next.resetView).toBe("r"); // intact
    expect(next.keyImage).toBe("Ctrl+r");
  });

  it("réaffecter une action à son propre combo ne la vide pas", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "resetView", "r");
    expect(next.resetView).toBe("r");
  });

  it("un combo vide désaffecte sans vider d'autres actions", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "resetView", "");
    expect(next.resetView).toBe("");
    expect(next.keyImage).toBe("k"); // les autres intactes
  });

  it("après réaffectation, matchEvent suit la nouvelle carte", () => {
    const next = setHotkey(DEFAULT_HOTKEYS, "resetView", "Ctrl+Shift+z");
    expect(matchEvent(next, { key: "z", ctrl: true, shift: true })).toBe(
      "resetView"
    );
    // ancien « r » ne déclenche plus resetView
    expect(matchEvent(next, { key: "r" })).toBeNull();
  });

  it("chaîne de réaffectations : la dernière gagne, dé-doublonnage maintenu", () => {
    let map = DEFAULT_HOTKEYS;
    map = setHotkey(map, "nextSlice", "n");
    map = setHotkey(map, "prevSlice", "n"); // collision → nextSlice vidé
    expect(map.prevSlice).toBe("n");
    expect(map.nextSlice).toBe("");
    expect(matchEvent(map, { key: "n" })).toBe("prevSlice");
  });
});
