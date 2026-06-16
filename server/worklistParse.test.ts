import { describe, it, expect } from "vitest";
import {
  parseWorklistAnswer,
  parseWorklistAnswers,
  formatPersonName,
  formatScheduledDateTime,
} from "./worklistParse";

describe("formatPersonName", () => {
  it("formats family^given", () => {
    expect(formatPersonName("DOE^JANE")).toBe("DOE, JANE");
  });
  it("handles family only", () => {
    expect(formatPersonName("DOE")).toBe("DOE");
  });
  it("handles empty", () => {
    expect(formatPersonName("")).toBe("");
  });
});

describe("formatScheduledDateTime", () => {
  it("formats DA + TM", () => {
    expect(formatScheduledDateTime("20260612", "143000")).toBe(
      "2026-06-12 14:30"
    );
  });
  it("formats DA only", () => {
    expect(formatScheduledDateTime("20260612", "")).toBe("2026-06-12");
  });
  it("formats TM only", () => {
    expect(formatScheduledDateTime("", "0900")).toBe("09:00");
  });
  it("returns empty when nothing", () => {
    expect(formatScheduledDateTime("", "")).toBe("");
  });
});

describe("parseWorklistAnswer", () => {
  it("flattens a full worklist answer with SPS sequence", () => {
    const answer = {
      "00100010": { Value: [{ Alphabetic: "DOE^JANE" }] },
      "00100020": { Value: ["PAT-42"] },
      "00100030": { Value: ["19800101"] },
      "00100040": { Value: ["F"] },
      "00080050": { Value: ["ACC-1001"] },
      "00400100": {
        vr: "SQ",
        Value: [
          {
            "00080060": { Value: ["CT"] },
            "00400002": { Value: ["20260612"] },
            "00400003": { Value: ["143000"] },
            "00400007": { Value: ["CT THORAX"] },
            "00400001": { Value: ["CT_SCANNER_1"] },
            "00400006": { Value: [{ Alphabetic: "SMITH^JOHN" }] },
          },
        ],
      },
    };
    const e = parseWorklistAnswer(answer);
    expect(e.patientName).toBe("DOE, JANE");
    expect(e.patientId).toBe("PAT-42");
    expect(e.patientSex).toBe("F");
    expect(e.accessionNumber).toBe("ACC-1001");
    expect(e.modality).toBe("CT");
    expect(e.scheduledDate).toBe("20260612");
    expect(e.scheduledTime).toBe("143000");
    expect(e.scheduledDateTime).toBe("2026-06-12 14:30");
    expect(e.procedureDescription).toBe("CT THORAX");
    expect(e.scheduledStationAet).toBe("CT_SCANNER_1");
    expect(e.performingPhysician).toBe("SMITH, JOHN");
  });

  it("falls back to RequestedProcedureDescription when SPS desc absent", () => {
    const answer = {
      "00321060": { Value: ["IRM CEREBRALE"] },
      "00400100": { Value: [{ "00080060": { Value: ["MR"] } }] },
    };
    const e = parseWorklistAnswer(answer);
    expect(e.procedureDescription).toBe("IRM CEREBRALE");
    expect(e.modality).toBe("MR");
  });

  it("never throws on an empty/partial answer (fail-soft)", () => {
    expect(() => parseWorklistAnswer({})).not.toThrow();
    const e = parseWorklistAnswer({});
    expect(e.patientName).toBe("");
    expect(e.modality).toBe("");
    expect(e.scheduledDateTime).toBe("");
  });
});

describe("parseWorklistAnswers", () => {
  it("parses a list", () => {
    const out = parseWorklistAnswers([
      { "00100020": { Value: ["A"] } },
      { "00100020": { Value: ["B"] } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].patientId).toBe("A");
  });
  it("returns [] for non-array / null", () => {
    expect(parseWorklistAnswers(null)).toEqual([]);
    expect(parseWorklistAnswers(undefined)).toEqual([]);
    expect(parseWorklistAnswers("nope")).toEqual([]);
  });
});
