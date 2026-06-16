import { describe, it, expect } from "vitest";
import {
  pickHangingProtocol,
  DEFAULT_HANGING_PROTOCOL,
} from "./hangingProtocols";

describe("pickHangingProtocol", () => {
  it("CT chest → Lung preset", () => {
    const p = pickHangingProtocol("CT", "CT CHEST W/O CONTRAST");
    expect(p.wlPreset).toBe("Lung");
    expect(p.id).toBe("ct-chest");
  });

  it("CT head → Brain preset (French keyword)", () => {
    const p = pickHangingProtocol("CT", "Scanner crâne sans injection");
    expect(p.wlPreset).toBe("Brain");
  });

  it("CT bone series → Bone preset", () => {
    const p = pickHangingProtocol("CT", "Rachis lombaire - os");
    expect(p.wlPreset).toBe("Bone");
  });

  it("CT abdomen → Abdomen preset", () => {
    const p = pickHangingProtocol("CT", "ABDOMEN PELVIS");
    expect(p.wlPreset).toBe("Abdomen");
  });

  it("CT with no matching keyword → CT default", () => {
    const p = pickHangingProtocol("CT", "Acquisition standard");
    expect(p.id).toBe("ct-default");
    expect(p.wlPreset).toBe("Default");
  });

  it("MR → MR default protocol", () => {
    const p = pickHangingProtocol("MR", "T1 SAG");
    expect(p.id).toBe("mr-default");
    expect(p.wlPreset).toBe("Default");
  });

  it("is case-insensitive on modality", () => {
    const p = pickHangingProtocol("ct", "lung");
    expect(p.wlPreset).toBe("Lung");
  });

  it("unknown modality → default fallback", () => {
    expect(pickHangingProtocol("US", "abdo")).toEqual(DEFAULT_HANGING_PROTOCOL);
  });

  it("empty/missing modality → default fallback", () => {
    expect(pickHangingProtocol("", "chest")).toEqual(DEFAULT_HANGING_PROTOCOL);
    expect(pickHangingProtocol(null, null)).toEqual(DEFAULT_HANGING_PROTOCOL);
  });

  it("never throws on missing description", () => {
    expect(() => pickHangingProtocol("CT", undefined)).not.toThrow();
    const p = pickHangingProtocol("CT", undefined);
    expect(p.id).toBe("ct-default");
  });
});
