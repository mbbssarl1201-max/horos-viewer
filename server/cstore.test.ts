import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cStore, cStoreStudy, lookupStudyOrthancId } from "./orthanc";

// Exercise the C-STORE path end-to-end against a mocked Orthanc REST API.
// Focus: AE-title anti-SSRF guard, StudyInstanceUID -> resource-id resolution,
// and graceful "not found" handling.

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("orthanc C-STORE", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an unsafe target AE title (anti-SSRF) without calling fetch", async () => {
    await expect(
      cStore({ targetAet: "../../system", orthancId: "abc" })
    ).rejects.toThrow("Invalid AE Title");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a StudyInstanceUID to its Orthanc resource id", async () => {
    (fetch as any).mockResolvedValueOnce(
      jsonResponse([
        { Type: "Series", ID: "series-id" },
        { Type: "Study", ID: "study-resource-id" },
      ])
    );
    const id = await lookupStudyOrthancId("1.2.3.4.5");
    expect(id).toBe("study-resource-id");
  });

  it("returns 'not found' (no store call) when the study is unknown", async () => {
    (fetch as any).mockResolvedValueOnce(jsonResponse([]));
    const res = await cStoreStudy({
      targetAet: "PACS",
      studyInstanceUID: "9.9.9",
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not found/i);
    // Only the lookup happened, never the /store POST.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stores the resolved study and reports success", async () => {
    (fetch as any)
      .mockResolvedValueOnce(jsonResponse([{ Type: "Study", ID: "rid" }]))
      .mockResolvedValueOnce(jsonResponse({}, true, 200));
    const res = await cStoreStudy({
      targetAet: "PACS",
      studyInstanceUID: "1.2.3",
    });
    expect(res.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The store call targets the validated modality and the resolved resource.
    const storeCall = (fetch as any).mock.calls[1];
    expect(storeCall[0]).toContain("/modalities/PACS/store");
    expect(storeCall[1].body).toContain("rid");
  });
});
