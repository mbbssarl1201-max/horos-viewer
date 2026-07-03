// Logique de tri du tableau Database (Home), extraite pour être testable
// indépendamment du composant (Story 5.1).
export type SortKey =
  | "patientName"
  | "patientDicomId"
  | "accessionNumber"
  | "studyDescription"
  | "modality"
  | "id"
  | "studyDate";

export interface SortableStudy {
  id: number;
  patientName?: string | null;
  patientDicomId?: string | null;
  accessionNumber?: string | null;
  studyDescription?: string | null;
  modality?: string | null;
  studyDate?: string | null;
}

function sortValue(s: SortableStudy, key: SortKey): string | number {
  switch (key) {
    case "patientName":
      return (s.patientName ?? "").toLowerCase();
    case "patientDicomId":
      return (s.patientDicomId ?? "").toLowerCase();
    case "accessionNumber":
      return (s.accessionNumber ?? "").toLowerCase();
    case "studyDescription":
      return (s.studyDescription ?? "").toLowerCase();
    case "modality":
      return (s.modality ?? "").toLowerCase();
    case "id":
      return s.id ?? 0;
    case "studyDate":
      return s.studyDate ?? "";
    default:
      return "";
  }
}

/** Tri stable : départage les égalités par `id` dans le sens courant. */
export function sortStudies<T extends SortableStudy>(
  rows: T[],
  key: SortKey | null,
  dir: "asc" | "desc"
): T[] {
  if (!key) return rows;
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return -1 * d;
    if (av > bv) return 1 * d;
    return (a.id - b.id) * d;
  });
}

/** Cycle d'un clic d'en-tête : asc → desc → tri naturel (null). */
export function nextSort(
  current: { key: SortKey | null; dir: "asc" | "desc" },
  clicked: SortKey
): { key: SortKey | null; dir: "asc" | "desc" } {
  if (current.key !== clicked) return { key: clicked, dir: "asc" };
  if (current.dir === "asc") return { key: clicked, dir: "desc" };
  return { key: null, dir: "asc" };
}
