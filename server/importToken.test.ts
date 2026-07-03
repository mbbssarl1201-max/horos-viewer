import { afterEach, describe, expect, it } from "vitest";
import { isValidImportToken } from "./importToken";

const TOKEN = "a".repeat(40);

afterEach(() => {
  delete process.env.DICOM_IMPORT_TOKEN;
});

describe("isValidImportToken", () => {
  it("accepte le bon jeton en Bearer", () => {
    process.env.DICOM_IMPORT_TOKEN = TOKEN;
    expect(isValidImportToken(`Bearer ${TOKEN}`)).toBe(true);
  });

  it("refuse un mauvais jeton, même de bonne longueur", () => {
    process.env.DICOM_IMPORT_TOKEN = TOKEN;
    expect(isValidImportToken(`Bearer ${"b".repeat(40)}`)).toBe(false);
  });

  it("refuse sans préfixe Bearer", () => {
    process.env.DICOM_IMPORT_TOKEN = TOKEN;
    expect(isValidImportToken(TOKEN)).toBe(false);
  });

  it("inactif si la variable est absente ou trop courte (< 32 car.)", () => {
    expect(isValidImportToken(`Bearer ${TOKEN}`)).toBe(false);
    process.env.DICOM_IMPORT_TOKEN = "court";
    expect(isValidImportToken("Bearer court")).toBe(false);
  });

  it("refuse en-tête absent, tableau ou longueur différente", () => {
    process.env.DICOM_IMPORT_TOKEN = TOKEN;
    expect(isValidImportToken(undefined)).toBe(false);
    expect(isValidImportToken([`Bearer ${TOKEN}`])).toBe(false);
    expect(isValidImportToken(`Bearer ${TOKEN}x`)).toBe(false);
    expect(isValidImportToken(`Bearer ${TOKEN.slice(0, 39)}`)).toBe(false);
  });
});
