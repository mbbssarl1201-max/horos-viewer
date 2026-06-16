// Tiny structured logger (JSON lines). Additive: it does NOT replace the
// existing console.* calls scattered across the codebase — it's used in a few
// key spots (server start, storage proxy / report send errors) so logs there
// are machine-parseable (one JSON object per line: level, msg, time, fields).
//
// No PHI must ever be passed in `fields` — keep it to ids, actions, counts.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  [key: string]: unknown;
}

/** Build a structured log entry (pure — easy to unit test). */
export function formatLog(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
  now: Date = new Date()
): LogEntry {
  return {
    level,
    msg,
    time: now.toISOString(),
    ...(fields ?? {}),
  };
}

function emit(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>
): void {
  const entry = formatLog(level, msg, fields);
  const line = JSON.stringify(entry);
  // Route to the matching console stream so existing log collectors still work.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};
