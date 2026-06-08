import { describe, it, expect } from "vitest";
import { isValidDicomUid } from "./dicomwebProxy";

describe("isValidDicomUid", () => {
  it("accepte un UID DICOM valide", () => {
    expect(isValidDicomUid("1.3.6.1.4.1.14519.5.2.1.7009.2403.3342")).toBe(
      true
    );
  });
  it("rejette les caractères de path traversal", () => {
    expect(isValidDicomUid("../../etc/passwd")).toBe(false);
    expect(isValidDicomUid("1.2.3/4")).toBe(false);
    expect(isValidDicomUid("1.2.3 4")).toBe(false);
  });
  it("rejette le vide et les UID trop longs (>64)", () => {
    expect(isValidDicomUid("")).toBe(false);
    expect(isValidDicomUid("1".repeat(65))).toBe(false);
  });
});
