import { describe, it, expect } from "vitest";
import { deriveWadorsImageIds } from "./wadorsImageIds";

const meta = [
  { "00080018": { Value: ["1.2.3.1"] }, "00280008": { Value: ["1"] } },
  { "00080018": { Value: ["1.2.3.2"] } }, // pas de NumberOfFrames → 1 frame
];

describe("deriveWadorsImageIds", () => {
  it("construit un imageId wadors par frame", () => {
    const ids = deriveWadorsImageIds(meta, {
      root: "/api/dicomweb",
      studyUid: "1.2",
      seriesUid: "3.4",
    });
    expect(ids).toEqual([
      "wadors:/api/dicomweb/studies/1.2/series/3.4/instances/1.2.3.1/frames/1",
      "wadors:/api/dicomweb/studies/1.2/series/3.4/instances/1.2.3.2/frames/1",
    ]);
  });

  it("gère le multiframe", () => {
    const mf = [
      { "00080018": { Value: ["1.2.3.9"] }, "00280008": { Value: ["3"] } },
    ];
    const ids = deriveWadorsImageIds(mf, {
      root: "/api/dicomweb",
      studyUid: "1.2",
      seriesUid: "3.4",
    });
    expect(ids).toHaveLength(3);
    expect(ids[2]).toContain("/instances/1.2.3.9/frames/3");
  });

  it("ignore les instances sans SOPInstanceUID", () => {
    const bad = [{ "00280008": { Value: ["1"] } }];
    expect(
      deriveWadorsImageIds(bad, {
        root: "/api/dicomweb",
        studyUid: "1.2",
        seriesUid: "3.4",
      })
    ).toEqual([]);
  });
});
