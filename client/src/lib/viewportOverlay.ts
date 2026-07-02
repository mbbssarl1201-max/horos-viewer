export interface CursorData {
  xPx: number;
  yPx: number;
  xMm: number | null;
  yMm: number | null;
  value: number | null;
}

/** Lecture curseur façon Horos : px + mm (si dispo) + valeur du pixel. PUR. */
export function formatCursorReadout(c: CursorData): string {
  const parts: string[] = [`px (${Math.round(c.xPx)}, ${Math.round(c.yPx)})`];
  if (c.xMm != null && c.yMm != null) {
    parts.unshift(`X: ${c.xMm.toFixed(1)} mm Y: ${c.yMm.toFixed(1)} mm`);
  }
  if (c.value != null) parts.push(`Val ${Math.round(c.value)}`);
  return parts.join(" — ");
}

/** Direction dominante d'un vecteur de cosinus directeurs → lettre anatomique. */
function axisLetter(x: number, y: number, z: number): string {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  if (ax >= ay && ax >= az) return x < 0 ? "R" : "L";
  if (ay >= ax && ay >= az) return y < 0 ? "A" : "P";
  return z < 0 ? "F" : "H";
}

/** Étiquettes d'orientation patient à partir d'ImageOrientationPatient (6 val). PUR. */
export function patientOrientationLabels(iop: number[] | null): {
  top: string;
  bottom: string;
  left: string;
  right: string;
} {
  if (!iop || iop.length < 6)
    return { top: "", bottom: "", left: "", right: "" };
  const [rx, ry, rz, cx, cy, cz] = iop;
  const left = axisLetter(rx, ry, rz); // bord gauche = -direction ligne
  const top = axisLetter(cx, cy, cz); // bord haut = -direction colonne
  const opp = (l: string) =>
    ({ L: "R", R: "L", A: "P", P: "A", H: "F", F: "H" })[l] ?? "";
  return { left: opp(left), right: left, top: opp(top), bottom: top };
}

export function formatImageInfo(info: {
  rows?: number;
  cols?: number;
  zoomPct?: number;
  angleDeg?: number;
}): string[] {
  const lines: string[] = [];
  if (info.cols && info.rows) lines.push(`Image: ${info.cols} × ${info.rows}`);
  if (info.zoomPct != null)
    lines.push(
      `Zoom: ${Math.round(info.zoomPct)}%` +
        (info.angleDeg != null ? ` Angle: ${Math.round(info.angleDeg)}` : "")
    );
  return lines;
}
