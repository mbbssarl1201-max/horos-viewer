import { describe, it, expect, vi, afterEach } from "vitest";
import {
  anthropicCreate,
  anthropicMessagesFetch,
  REFUSAL_FALLBACK_MODEL,
} from "./anthropicClient";

const refusal = { stop_reason: "refusal", content: [] };
const ok = { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] };

function res(json: unknown, okFlag = true) {
  return { ok: okFlag, json: async () => json };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anthropicMessagesFetch — repli sur refus (fetch brut)", () => {
  it("modèle Fable : un refus rejoue la requête sur Opus 4.8", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(refusal))
      .mockResolvedValueOnce(res(ok));
    vi.stubGlobal("fetch", fetchMock);

    const data = await anthropicMessagesFetch(
      { model: "claude-fable-5", max_tokens: 10, messages: [] },
      undefined,
      "sk-test"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.model).toBe(REFUSAL_FALLBACK_MODEL);
    expect(data).toEqual(ok);
  });

  it("modèle Fable : pas de refus → aucun rejeu", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(ok));
    vi.stubGlobal("fetch", fetchMock);

    const data = await anthropicMessagesFetch(
      { model: "claude-fable-5", max_tokens: 10, messages: [] },
      undefined,
      "sk-test"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data).toEqual(ok);
  });

  it("modèle non-Fable : un refus n'est PAS rejoué", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(refusal));
    vi.stubGlobal("fetch", fetchMock);

    const data = await anthropicMessagesFetch(
      { model: "claude-opus-4-8", max_tokens: 10, messages: [] },
      undefined,
      "sk-test"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data).toEqual(refusal);
  });

  it("échec HTTP → null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({}, false)));
    const data = await anthropicMessagesFetch(
      { model: "claude-fable-5", max_tokens: 10, messages: [] },
      undefined,
      "sk-test"
    );
    expect(data).toBeNull();
  });
});

describe("anthropicCreate — repli sur refus (SDK)", () => {
  it("modèle Fable : un refus rejoue sur Opus 4.8", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(ok);
    const client = { messages: { create } } as never;

    const resp = await anthropicCreate(client, {
      model: "claude-fable-5",
      max_tokens: 10,
      messages: [],
    } as never);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].model).toBe(REFUSAL_FALLBACK_MODEL);
    expect(resp).toEqual(ok);
  });

  it("modèle non-Fable : un refus n'est PAS rejoué", async () => {
    const create = vi.fn().mockResolvedValue(refusal);
    const client = { messages: { create } } as never;

    const resp = await anthropicCreate(client, {
      model: "claude-opus-4-8",
      max_tokens: 10,
      messages: [],
    } as never);

    expect(create).toHaveBeenCalledTimes(1);
    expect(resp).toEqual(refusal);
  });
});
