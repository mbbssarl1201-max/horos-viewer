import { ENV } from "../_core/env";

/** Gemini Vertex (UE) configuré ? (sinon repli local). */
export function vertexConfigured(): boolean {
  return (
    ENV.chatBackend === "vertex" &&
    !!ENV.geminiVertexProject &&
    !!ENV.geminiVertexToken
  );
}
