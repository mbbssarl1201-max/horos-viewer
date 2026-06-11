// Small helper that bundles the three imports repeated across router
// procedures:  const { getDb } = await import("./db");
//              const { X } = await import("../drizzle/schema");
//              const { eq } = await import("drizzle-orm");
//
// Behaviour-preserving: same dynamic-import lazy-loading as before, just in
// one place. Returns the live db handle (may be null if DB is unavailable —
// callers must check, exactly as they did with getDb()), the full schema, and
// the common drizzle operators.

export async function dbCtx() {
  const [{ getDb }, schema, drizzleOps] = await Promise.all([
    import("../db"),
    import("../../drizzle/schema"),
    import("drizzle-orm"),
  ]);
  const db = await getDb();
  const { eq, and, or, desc, asc, gte, lte, lt, gt, ne, like, sql } =
    drizzleOps;
  return {
    db,
    schema,
    eq,
    and,
    or,
    desc,
    asc,
    gte,
    lte,
    lt,
    gt,
    ne,
    like,
    sql,
  };
}
