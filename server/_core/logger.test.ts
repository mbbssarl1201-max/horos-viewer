import { describe, expect, it } from "vitest";
import { formatLog } from "./logger";

describe("formatLog (journalisation structurée JSON)", () => {
  const now = new Date("2026-06-11T10:00:00.000Z");

  it("produit level/msg/time + heure ISO", () => {
    const e = formatLog("info", "server.started", undefined, now);
    expect(e.level).toBe("info");
    expect(e.msg).toBe("server.started");
    expect(e.time).toBe("2026-06-11T10:00:00.000Z");
  });

  it("fusionne les champs additionnels", () => {
    const e = formatLog("error", "boom", { port: 3000, code: "X" }, now);
    expect(e.port).toBe(3000);
    expect(e.code).toBe("X");
    expect(e.level).toBe("error");
  });

  it("reste sérialisable en une ligne JSON", () => {
    const e = formatLog("warn", "x", { a: 1 }, now);
    expect(() => JSON.parse(JSON.stringify(e))).not.toThrow();
  });
});
