import { describe, it, expect, vi } from "vitest";
const env = vi.hoisted(() => ({
  chatBackend: "local",
  geminiVertexProject: "",
  geminiVertexToken: "",
})) as any;
vi.mock("../_core/env", () => ({ ENV: env }));
import { vertexConfigured } from "./hermesBackend";
describe("backend Vertex", () => {
  it("non configuré par défaut → local", () => {
    expect(vertexConfigured()).toBe(false);
  });
  it("configuré si vertex + project + token", () => {
    env.chatBackend = "vertex";
    env.geminiVertexProject = "p";
    env.geminiVertexToken = "t";
    expect(vertexConfigured()).toBe(true);
  });
});
