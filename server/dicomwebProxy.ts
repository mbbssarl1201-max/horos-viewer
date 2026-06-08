/**
 * Un UID DICOM est une suite de chiffres séparés par des points, max 64 caractères
 * (PS 3.5). On l'exige strictement avant de l'interpoler dans une URL Orthanc :
 * défense en profondeur contre le path traversal / SSRF.
 */
export function isValidDicomUid(uid: string): boolean {
  return (
    typeof uid === "string" &&
    /^[0-9]+(\.[0-9]+)*$/.test(uid) &&
    uid.length <= 64 &&
    uid.length > 0
  );
}
