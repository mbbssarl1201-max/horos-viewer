import { describe, it, expect } from "vitest";
import { build4dIndex, detect4d, type TemporalInstance } from "./temporal4d";

/**
 * Fabrique une grille 4D régulière : `nTimes` phases × `nSlices` coupes.
 * Ordre d'insertion mélangé (temps externe, coupe interne) pour vérifier que
 * l'indexation ne dépend pas de l'ordre d'entrée.
 */
function makeGrid(nTimes: number, nSlices: number): TemporalInstance[] {
  const out: TemporalInstance[] = [];
  for (let t = 0; t < nTimes; t += 1) {
    for (let s = 0; s < nSlices; s += 1) {
      out.push({ timeIndex: t, sliceLocation: s * 2.5 });
    }
  }
  return out;
}

describe("build4dIndex", () => {
  it("construit les axes triés distincts (grille régulière)", () => {
    const idx = build4dIndex(makeGrid(3, 4));
    expect(idx.times).toEqual([0, 1, 2]);
    expect(idx.sliceLocations).toEqual([0, 2.5, 5, 7.5]);
    expect(idx.timeCount).toBe(3);
    expect(idx.slicesPerTime).toBe(4);
  });

  it("frameAt renvoie l'indice d'origine du bon couple (temps, coupe)", () => {
    const inst = makeGrid(2, 3); // 0:(t0,s0) 1:(t0,s1) 2:(t0,s2) 3:(t1,s0)...
    const idx = build4dIndex(inst);
    expect(idx.frameAt(0, 0)).toBe(0);
    expect(idx.frameAt(0, 2)).toBe(2);
    expect(idx.frameAt(1, 0)).toBe(3);
    expect(idx.frameAt(1, 2)).toBe(5);
    // Cohérence : l'instance pointée a bien les bonnes coordonnées.
    const ref = inst[idx.frameAt(1, 1)];
    expect(ref.timeIndex).toBe(1);
    expect(ref.sliceLocation).toBe(2.5);
  });

  it("ne dépend pas de l'ordre d'entrée", () => {
    const ordered = makeGrid(2, 2);
    const shuffled = [ordered[3], ordered[0], ordered[2], ordered[1]];
    const a = build4dIndex(ordered);
    const b = build4dIndex(shuffled);
    expect(a.times).toEqual(b.times);
    expect(a.sliceLocations).toEqual(b.sliceLocations);
    // Le couple (t1,s1) existe dans les deux, pointant vers la bonne instance.
    expect(ordered[a.frameAt(1, 1)].timeIndex).toBe(1);
    expect(shuffled[b.frameAt(1, 1)].timeIndex).toBe(1);
  });

  it("trie des valeurs fournies en désordre et avec doublons", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 2, sliceLocation: 10 },
      { timeIndex: 0, sliceLocation: 0 },
      { timeIndex: 2, sliceLocation: 0 },
      { timeIndex: 0, sliceLocation: 10 },
    ];
    const idx = build4dIndex(inst);
    expect(idx.times).toEqual([0, 2]);
    expect(idx.sliceLocations).toEqual([0, 10]);
  });

  it("conserve la PREMIÈRE instance en cas de doublon de couple", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 0, sliceLocation: 0 }, // 0
      { timeIndex: 0, sliceLocation: 0 }, // 1 (doublon)
      { timeIndex: 1, sliceLocation: 0 }, // 2
    ];
    const idx = build4dIndex(inst);
    expect(idx.frameAt(0, 0)).toBe(0); // pas 1
  });

  it("fusionne les valeurs séparées de moins de l'epsilon", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 0, sliceLocation: 1.0 },
      { timeIndex: 0, sliceLocation: 1.00001 }, // ~= 1.0
    ];
    const idx = build4dIndex(inst);
    expect(idx.sliceLocations.length).toBe(1);
  });

  describe("frameAt — bornes et entrées invalides", () => {
    const idx = build4dIndex(makeGrid(2, 3));
    it("hors bornes → -1", () => {
      expect(idx.frameAt(-1, 0)).toBe(-1);
      expect(idx.frameAt(0, -1)).toBe(-1);
      expect(idx.frameAt(2, 0)).toBe(-1);
      expect(idx.frameAt(0, 3)).toBe(-1);
    });
    it("indices non entiers → -1", () => {
      expect(idx.frameAt(0.5, 0)).toBe(-1);
      expect(idx.frameAt(0, 1.5)).toBe(-1);
      expect(idx.frameAt(NaN, 0)).toBe(-1);
    });
  });

  describe("cas dégénérés", () => {
    it("liste vide → grille vide, frameAt toujours -1", () => {
      const idx = build4dIndex([]);
      expect(idx.times).toEqual([]);
      expect(idx.sliceLocations).toEqual([]);
      expect(idx.timeCount).toBe(0);
      expect(idx.slicesPerTime).toBe(0);
      expect(idx.frameAt(0, 0)).toBe(-1);
    });

    it("instance unique → grille 1×1", () => {
      const idx = build4dIndex([{ timeIndex: 5, sliceLocation: 3 }]);
      expect(idx.timeCount).toBe(1);
      expect(idx.slicesPerTime).toBe(1);
      expect(idx.frameAt(0, 0)).toBe(0);
    });

    it("ignore les coordonnées non finies (axes et indexation)", () => {
      const inst: TemporalInstance[] = [
        { timeIndex: 0, sliceLocation: 0 },
        { timeIndex: NaN, sliceLocation: NaN },
        { timeIndex: 1, sliceLocation: Infinity },
      ];
      const idx = build4dIndex(inst);
      // Seul timeIndex=1 fini (slice Infinity ignorée), timeIndex=0 fini.
      expect(idx.times).toEqual([0, 1]);
      expect(idx.sliceLocations).toEqual([0]);
      // Le couple (t=1, s=0) est vide car l'instance avait slice=Infinity.
      expect(idx.frameAt(1, 0)).toBe(-1);
      expect(idx.frameAt(0, 0)).toBe(0);
    });

    it("grille partielle (cellule manquante) → frameAt -1 sur la case vide", () => {
      const inst: TemporalInstance[] = [
        { timeIndex: 0, sliceLocation: 0 },
        { timeIndex: 0, sliceLocation: 1 },
        { timeIndex: 1, sliceLocation: 0 },
        // manque (t1, s1)
      ];
      const idx = build4dIndex(inst);
      expect(idx.frameAt(1, 1)).toBe(-1);
      expect(idx.frameAt(0, 1)).toBe(1);
    });

    it("ne mute pas la liste d'entrée", () => {
      const inst = makeGrid(2, 2);
      const copy = JSON.parse(JSON.stringify(inst));
      build4dIndex(inst);
      expect(inst).toEqual(copy);
    });
  });
});

describe("detect4d", () => {
  it("grille régulière complète 2×2 → true", () => {
    expect(detect4d(makeGrid(2, 2))).toBe(true);
  });

  it("grille régulière complète 4×8 → true", () => {
    expect(detect4d(makeGrid(4, 8))).toBe(true);
  });

  it("série purement spatiale (1 seul temps) → false", () => {
    expect(detect4d(makeGrid(1, 10))).toBe(false);
  });

  it("série purement temporelle (1 seule coupe) → false", () => {
    expect(detect4d(makeGrid(10, 1))).toBe(false);
  });

  it("moins de 4 instances → false", () => {
    expect(detect4d([])).toBe(false);
    expect(detect4d([{ timeIndex: 0, sliceLocation: 0 }])).toBe(false);
    expect(
      detect4d([
        { timeIndex: 0, sliceLocation: 0 },
        { timeIndex: 1, sliceLocation: 0 },
        { timeIndex: 0, sliceLocation: 1 },
      ])
    ).toBe(false);
  });

  it("grille incomplète (cellule manquante) → false", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 0, sliceLocation: 0 },
      { timeIndex: 0, sliceLocation: 1 },
      { timeIndex: 1, sliceLocation: 0 },
      // manque (t1, s1) mais 4 instances seraient attendues → ici 3
      { timeIndex: 1, sliceLocation: 0 }, // doublon au lieu de la case manquante
    ];
    expect(detect4d(inst)).toBe(false);
  });

  it("doublon faisant dépasser le compte attendu → false", () => {
    const inst: TemporalInstance[] = [
      ...makeGrid(2, 2),
      { timeIndex: 0, sliceLocation: 0 }, // doublon → 5 instances pour 4 cellules
    ];
    expect(detect4d(inst)).toBe(false);
  });

  it("coordonnée non finie → false", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 0, sliceLocation: 0 },
      { timeIndex: 0, sliceLocation: 1 },
      { timeIndex: 1, sliceLocation: 0 },
      { timeIndex: 1, sliceLocation: NaN },
    ];
    expect(detect4d(inst)).toBe(false);
  });

  it("grille irrégulière (coupes différentes selon le temps) → false", () => {
    const inst: TemporalInstance[] = [
      { timeIndex: 0, sliceLocation: 0 },
      { timeIndex: 0, sliceLocation: 1 },
      { timeIndex: 1, sliceLocation: 0 },
      { timeIndex: 1, sliceLocation: 2 }, // 2 au lieu de 1
    ];
    // 3 coupes distinctes (0,1,2) × 2 temps = 6 cellules attendues, 4 fournies.
    expect(detect4d(inst)).toBe(false);
  });
});
