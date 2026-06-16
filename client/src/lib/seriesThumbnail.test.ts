import { describe, it, expect } from "vitest";
import {
  pickRepresentativeIndex,
  representativeImageId,
} from "./seriesThumbnail";

describe("pickRepresentativeIndex", () => {
  it("prend la coupe du milieu", () => {
    expect(pickRepresentativeIndex(1)).toBe(0);
    expect(pickRepresentativeIndex(2)).toBe(1);
    expect(pickRepresentativeIndex(5)).toBe(2);
    expect(pickRepresentativeIndex(100)).toBe(50);
  });
  it("gère les entrées dégénérées", () => {
    expect(pickRepresentativeIndex(0)).toBe(-1);
    expect(pickRepresentativeIndex(-3)).toBe(-1);
    expect(pickRepresentativeIndex(NaN)).toBe(-1);
  });
});

describe("representativeImageId", () => {
  it("construit un image id wadouri pour la coupe du milieu", () => {
    const instances = [
      { storageUrl: "/manus-storage/a.dcm" },
      { storageUrl: "/manus-storage/b.dcm" },
      { storageUrl: "/manus-storage/c.dcm" },
    ];
    expect(representativeImageId(instances)).toBe(
      "wadouri:/manus-storage/b.dcm"
    );
  });
  it("retombe sur la première URL exploitable si celle du milieu manque", () => {
    const instances = [
      { storageUrl: "/manus-storage/a.dcm" },
      { storageUrl: null },
      { storageUrl: "/manus-storage/c.dcm" },
    ];
    expect(representativeImageId(instances)).toBe(
      "wadouri:/manus-storage/a.dcm"
    );
  });
  it("renvoie null sans instances ou sans URL exploitable", () => {
    expect(representativeImageId([])).toBeNull();
    expect(representativeImageId(null)).toBeNull();
    expect(representativeImageId([{ storageUrl: "" }])).toBeNull();
  });
});
