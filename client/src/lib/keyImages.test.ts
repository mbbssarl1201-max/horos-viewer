import { describe, it, expect } from "vitest";
import {
  toggleKeyImage,
  nextKeyImage,
  prevKeyImage,
  markAll,
  unmarkAll,
} from "./keyImages";

describe("toggleKeyImage", () => {
  it("ajoute un index absent et garde la liste triée", () => {
    expect(toggleKeyImage([], 3)).toEqual([3]);
    expect(toggleKeyImage([5, 1], 3)).toEqual([1, 3, 5]);
  });

  it("retire un index déjà présent", () => {
    expect(toggleKeyImage([1, 3, 5], 3)).toEqual([1, 5]);
    expect(toggleKeyImage([3], 3)).toEqual([]);
  });

  it("normalise l'entrée (doublons + désordre) en sortie", () => {
    expect(toggleKeyImage([5, 5, 1, 1], 9)).toEqual([1, 5, 9]);
  });

  it("ne mute pas le tableau source", () => {
    const src = [1, 2];
    const out = toggleKeyImage(src, 3);
    expect(src).toEqual([1, 2]);
    expect(out).not.toBe(src);
  });

  it("ignore un index invalide et renvoie la liste normalisée", () => {
    expect(toggleKeyImage([5, 1, 1], -2)).toEqual([1, 5]);
    expect(toggleKeyImage([5, 1], 2.5)).toEqual([1, 5]);
    expect(toggleKeyImage([5, 1], NaN)).toEqual([1, 5]);
  });

  it("nettoie les entrées invalides présentes dans la source", () => {
    expect(toggleKeyImage([-1, 2.5, 3, NaN], 4)).toEqual([3, 4]);
  });

  it("accepte l'index 0", () => {
    expect(toggleKeyImage([], 0)).toEqual([0]);
    expect(toggleKeyImage([0], 0)).toEqual([]);
  });
});

describe("nextKeyImage", () => {
  it("renvoie la clé suivante strictement après current", () => {
    expect(nextKeyImage([1, 4, 9], 4)).toBe(9);
    expect(nextKeyImage([1, 4, 9], 5)).toBe(9);
    expect(nextKeyImage([1, 4, 9], 0)).toBe(1);
  });

  it("boucle vers la première clé quand current est ≥ dernière", () => {
    expect(nextKeyImage([1, 4, 9], 9)).toBe(1);
    expect(nextKeyImage([1, 4, 9], 100)).toBe(1);
  });

  it("renvoie current si aucune clé", () => {
    expect(nextKeyImage([], 7)).toBe(7);
  });

  it("une seule clé : boucle sur elle-même si on est dessus ou après", () => {
    expect(nextKeyImage([5], 5)).toBe(5);
    expect(nextKeyImage([5], 6)).toBe(5);
    expect(nextKeyImage([5], 2)).toBe(5);
  });

  it("normalise l'entrée avant de chercher", () => {
    expect(nextKeyImage([9, 1, 4, 4], 1)).toBe(4);
  });
});

describe("prevKeyImage", () => {
  it("renvoie la clé précédente strictement avant current", () => {
    expect(prevKeyImage([1, 4, 9], 4)).toBe(1);
    expect(prevKeyImage([1, 4, 9], 5)).toBe(4);
    expect(prevKeyImage([1, 4, 9], 9)).toBe(4);
  });

  it("boucle vers la dernière clé quand current est ≤ première", () => {
    expect(prevKeyImage([1, 4, 9], 1)).toBe(9);
    expect(prevKeyImage([1, 4, 9], 0)).toBe(9);
    expect(prevKeyImage([1, 4, 9], -5)).toBe(9);
  });

  it("renvoie current si aucune clé", () => {
    expect(prevKeyImage([], 7)).toBe(7);
  });

  it("une seule clé : boucle sur elle-même si on est dessus ou avant", () => {
    expect(prevKeyImage([5], 5)).toBe(5);
    expect(prevKeyImage([5], 4)).toBe(5);
    expect(prevKeyImage([5], 8)).toBe(5);
  });

  it("normalise l'entrée avant de chercher", () => {
    expect(prevKeyImage([9, 1, 4, 4], 9)).toBe(4);
  });
});

describe("nextKeyImage / prevKeyImage symétrie", () => {
  it("naviguer suivant puis précédent revient au point de départ (cas non bouclé)", () => {
    const keys = [2, 5, 8];
    const n = nextKeyImage(keys, 5); // 8
    expect(prevKeyImage(keys, n)).toBe(5);
  });
});

describe("markAll", () => {
  it("marque toutes les coupes [0, count)", () => {
    expect(markAll(3)).toEqual([0, 1, 2]);
    expect(markAll(1)).toEqual([0]);
  });

  it("renvoie une liste vide pour count ≤ 0", () => {
    expect(markAll(0)).toEqual([]);
    expect(markAll(-4)).toEqual([]);
  });

  it("renvoie une liste vide pour count non entier", () => {
    expect(markAll(2.5)).toEqual([]);
    expect(markAll(NaN)).toEqual([]);
  });

  it("est cohérent avec nextKeyImage (parcours de toutes les coupes)", () => {
    const keys = markAll(4);
    expect(nextKeyImage(keys, 0)).toBe(1);
    expect(nextKeyImage(keys, 3)).toBe(0);
  });
});

describe("unmarkAll", () => {
  it("renvoie toujours une liste vide", () => {
    expect(unmarkAll()).toEqual([]);
  });

  it("renvoie un nouveau tableau à chaque appel", () => {
    expect(unmarkAll()).not.toBe(unmarkAll());
  });
});
