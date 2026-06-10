import { describe, it, expect } from "vitest";
import { resolveShortcut, shortcutLegend } from "./keyboardShortcuts";

const ev = (
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("resolveShortcut", () => {
  it("navigue dans la pile", () => {
    expect(resolveShortcut(ev("ArrowUp"), 4)).toEqual({ kind: "prevSlice" });
    expect(resolveShortcut(ev("PageDown"), 4)).toEqual({ kind: "nextSlice" });
    expect(resolveShortcut(ev("Home"), 4)).toEqual({ kind: "firstSlice" });
    expect(resolveShortcut(ev("End"), 4)).toEqual({ kind: "lastSlice" });
  });

  it("bascule le ciné avec Espace", () => {
    expect(resolveShortcut(ev(" "), 4)).toEqual({ kind: "cineToggle" });
  });

  it("sélectionne les outils par lettre (insensible à la casse)", () => {
    expect(resolveShortcut(ev("w"), 4)).toEqual({ kind: "tool", tool: "wwwl" });
    expect(resolveShortcut(ev("Z"), 4)).toEqual({ kind: "tool", tool: "zoom" });
    expect(resolveShortcut(ev("e"), 4)).toEqual({
      kind: "tool",
      tool: "ellipse",
    });
  });

  it("sélectionne les presets par chiffre dans les bornes", () => {
    expect(resolveShortcut(ev("1"), 4)).toEqual({ kind: "preset", index: 0 });
    expect(resolveShortcut(ev("4"), 4)).toEqual({ kind: "preset", index: 3 });
    expect(resolveShortcut(ev("5"), 4)).toBeNull();
    expect(resolveShortcut(ev("0"), 4)).toBeNull();
  });

  it("ignore les combinaisons avec modificateurs", () => {
    expect(resolveShortcut(ev("w", { ctrlKey: true }), 4)).toBeNull();
    expect(resolveShortcut(ev("ArrowUp", { metaKey: true }), 4)).toBeNull();
    expect(resolveShortcut(ev("1", { altKey: true }), 4)).toBeNull();
  });

  it("renvoie null pour une touche non mappée", () => {
    expect(resolveShortcut(ev("q"), 4)).toBeNull();
  });
});

describe("shortcutLegend", () => {
  it("liste les raccourcis et reflète le nombre de presets", () => {
    const legend = shortcutLegend(4);
    expect(legend.length).toBeGreaterThan(5);
    expect(legend.some(l => l.keys.includes("4"))).toBe(true);
  });
});
