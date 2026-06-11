// Optional Sentry error reporting — OPT-IN and fully guarded.
//
// Sentry is NOT a dependency of this project. This module enables it ONLY when:
//   1. the SENTRY_DSN env var is set, AND
//   2. the `@sentry/node` package happens to be installed.
// In every other case it no-ops, so the project compiles and runs without
// Sentry present. To enable: `npm i @sentry/node` and set SENTRY_DSN.

import { ENV } from "./env";
import { logger } from "./logger";

// Minimal shape we rely on — avoids a hard type dependency on @sentry/node.
interface SentryLike {
  init: (opts: { dsn: string; environment?: string }) => void;
  captureException: (e: unknown) => void;
}

let _sentry: SentryLike | null = null;
let _initialized = false;

/**
 * Initialize Sentry if (and only if) a DSN is configured and the package is
 * available. Safe to call once at startup; no-ops otherwise. Never throws.
 */
export async function initSentry(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  if (!ENV.sentryDsn) return;
  try {
    // Dynamic, name-obscured import so the bundler/tsc doesn't require the
    // package to be present at build time.
    const mod = (await import(
      /* @vite-ignore */ "@sentry/node" as string
    ).catch(() => null)) as SentryLike | null;
    if (!mod || typeof mod.init !== "function") {
      logger.warn("sentry.dsn_set_but_package_missing", {
        hint: "npm i @sentry/node to enable error reporting",
      });
      return;
    }
    mod.init({
      dsn: ENV.sentryDsn,
      environment: ENV.isProduction ? "production" : "development",
    });
    _sentry = mod;
    logger.info("sentry.initialized");
  } catch (err) {
    logger.warn("sentry.init_failed", { error: String(err) });
  }
}

/** Forward an exception to Sentry when active; no-op otherwise. */
export function captureException(e: unknown): void {
  if (_sentry) {
    try {
      _sentry.captureException(e);
    } catch {
      /* never let reporting break the request path */
    }
  }
}
