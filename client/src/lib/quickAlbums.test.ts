import { describe, it, expect } from "vitest";
import { isTodayMs, matchesTodayModality } from "./quickAlbums";

const NOON = new Date("2026-06-17T12:00:00").getTime();
const TODAY_MORNING = new Date("2026-06-17T08:30:00").getTime();
const YESTERDAY = new Date("2026-06-16T23:00:00").getTime();

describe("isTodayMs", () => {
  it("aujourd'hui → true", () => {
    expect(isTodayMs(TODAY_MORNING, NOON)).toBe(true);
  });
  it("hier → false", () => {
    expect(isTodayMs(YESTERDAY, NOON)).toBe(false);
  });
  it("null → false", () => {
    expect(isTodayMs(null, NOON)).toBe(false);
  });
});

describe("matchesTodayModality", () => {
  it("même modalité + aujourd'hui → true", () => {
    expect(
      matchesTodayModality("CT", { modality: "CT" }, TODAY_MORNING, NOON)
    ).toBe(true);
  });
  it("modalité insensible à la casse", () => {
    expect(
      matchesTodayModality("ct", { modality: "CT" }, TODAY_MORNING, NOON)
    ).toBe(true);
  });
  it("modalité différente → false", () => {
    expect(
      matchesTodayModality("CT", { modality: "MR" }, TODAY_MORNING, NOON)
    ).toBe(false);
  });
  it("bonne modalité mais pas aujourd'hui → false", () => {
    expect(
      matchesTodayModality("CT", { modality: "CT" }, YESTERDAY, NOON)
    ).toBe(false);
  });
});
