import { ENV } from "../_core/env";

// ─── Codes météo WMO → libellé français ───────────────────────────────────
const WMO_LABELS: Record<number, string> = {
  0: "Ciel dégagé",
  1: "Légèrement nuageux",
  2: "Partiellement nuageux",
  3: "Couvert",
  45: "Brouillard",
  48: "Brouillard givrant",
  51: "Bruine légère",
  53: "Bruine modérée",
  55: "Bruine dense",
  61: "Pluie légère",
  63: "Pluie modérée",
  65: "Pluie forte",
  71: "Neige légère",
  73: "Neige modérée",
  75: "Neige forte",
  80: "Averses légères",
  81: "Averses modérées",
  82: "Averses fortes",
  95: "Orage",
  96: "Orage avec grêle",
  99: "Orage avec forte grêle",
};

function wmoLabel(code: number): string {
  return WMO_LABELS[code] ?? `Code ${code}`;
}

// ─── Météo ─────────────────────────────────────────────────────────────────
export async function getWeatherFn(): Promise<{
  available: boolean;
  temperature?: number;
  condition?: string;
  tomorrow?: { temperature: number; condition: string };
}> {
  const lat = ENV.cabinetLat;
  const lng = ENV.cabinetLng;
  if (!lat || !lng) return { available: false };
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weathercode` +
    `&daily=temperature_2m_max,weathercode&timezone=Europe%2FZurich&forecast_days=2`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { available: false };
    const data = await resp.json();
    return {
      available: true,
      temperature: data.current?.temperature_2m,
      condition: wmoLabel(data.current?.weathercode ?? 0),
      tomorrow: {
        temperature:
          data.daily?.temperature_2m_max?.[1] ??
          data.daily?.temperature_2m_max?.[0],
        condition: wmoLabel(data.daily?.weathercode?.[1] ?? 0),
      },
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(t);
  }
}

// ─── Heure locale ──────────────────────────────────────────────────────────
export async function getLocalTimeFn(): Promise<{
  iso: string;
  formatted: string;
  timezone: string;
}> {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("fr-CH", {
    timeZone: "Europe/Zurich",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(now)
    .replace(" ", "T");
  return { iso, formatted, timezone: "Europe/Zurich" };
}

// ─── Calendrier (Google + études MySQL) ────────────────────────────────────
type CalEvent = {
  time: string;
  title: string;
  source: "gcal" | "studies";
  studyId?: number;
};

async function fetchGcalEvents(date: string): Promise<CalEvent[]> {
  const keyJson = ENV.googleServiceAccountJson;
  if (!keyJson) return [];
  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(keyJson),
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({ version: "v3", auth });
    const timeMin = new Date(`${date}T00:00:00+01:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59+01:00`).toISOString();
    const calendarId = ENV.googleCalendarId || "primary";
    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });
    return (resp.data.items ?? []).map(ev => ({
      time: ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString("fr-CH", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "00:00",
      title: ev.summary ?? "(sans titre)",
      source: "gcal" as const,
    }));
  } catch {
    return [];
  }
}

async function fetchStudyEvents(date: string): Promise<CalEvent[]> {
  try {
    const { getDb } = await import("../db");
    const { studies } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: studies.id,
        modality: studies.modality,
        studyDate: studies.studyDate,
      })
      .from(studies)
      .where(eq(studies.studyDate, date));
    return rows.map(r => ({
      time: "00:00",
      title: `Étude ${r.modality ?? "?"}`,
      source: "studies" as const,
      studyId: r.id,
    }));
  } catch {
    return [];
  }
}

export async function calendarTodayFn(args: { date?: string }): Promise<{
  events: CalEvent[];
}> {
  const date =
    args.date ??
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const [gcal, studyEvts] = await Promise.all([
    fetchGcalEvents(date),
    fetchStudyEvents(date),
  ]);
  const events = [...gcal, ...studyEvts].sort((a, b) =>
    a.time.localeCompare(b.time)
  );
  return { events };
}
