import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch for Open-Meteo
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../_core/env", () => ({
  ENV: {
    cabinetLat: "46.2",
    cabinetLng: "6.15",
    googleServiceAccountJson: "",
    googleCalendarId: "primary",
  },
}));
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../../drizzle/schema", () => ({ studies: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), sql: vi.fn() }));

import { getWeatherFn, getLocalTimeFn, calendarTodayFn } from "./contextTools";
import { getDb } from "../db";

describe("getLocalTimeFn", () => {
  it("retourne heure suisse correctement formatée", async () => {
    const result = await getLocalTimeFn();
    expect(result.timezone).toBe("Europe/Zurich");
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.formatted).toMatch(/\d{2}:\d{2}/);
  });
});

describe("getWeatherFn", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        current: { temperature_2m: 18, weathercode: 1 },
        daily: {
          temperature_2m_max: [20],
          weathercode: [3],
        },
      }),
    });
  });

  it("retourne la météo parsée correctement", async () => {
    const result = await getWeatherFn();
    expect(result.available).toBe(true);
    expect(result.temperature).toBe(18);
    expect(result.condition).toBeTruthy();
  });

  it("retourne available: false si fetch échoue", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const result = await getWeatherFn();
    expect(result.available).toBe(false);
  });

  it("retourne available: false si réponse non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await getWeatherFn();
    expect(result.available).toBe(false);
  });
});

describe("calendarTodayFn", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: 42, modality: "CT", studyDate: "2026-06-24" },
            ]),
        }),
      }),
    } as any);
  });

  it("retourne les études du jour comme événements", async () => {
    const result = await calendarTodayFn({ date: "2026-06-24" });
    const studyEvt = result.events.find(e => e.source === "studies");
    expect(studyEvt).toBeDefined();
    expect(studyEvt?.studyId).toBe(42);
  });

  it("fusionne Google Calendar et études (gcal absent = pas d'erreur)", async () => {
    const result = await calendarTodayFn({ date: "2026-06-24" });
    expect(Array.isArray(result.events)).toBe(true);
  });
});
