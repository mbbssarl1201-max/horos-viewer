import { useEffect, useRef, useState } from "react";
import {
  type OpacityPoint,
  type TfPreset,
  type ColorPoint,
  normalizeOpacityPoints,
  defaultOpacityRamp,
  serializePresets,
  deserializePresets,
  normalizeColorPoints,
  hexToRgb01,
  rgb01ToHex,
  defaultColorPoints,
} from "@/lib/transferFunction";

const LO = -1000;
const HI = 3000;
const W = 240;
const H = 96;
const HIT = 10;
const LS_KEY = "mediview.tfPresets";

function toX(value: number) {
  return ((value - LO) / (HI - LO)) * W;
}
function toY(opacity: number) {
  return H - opacity * H;
}
function fromX(x: number) {
  return LO + (Math.max(0, Math.min(W, x)) / W) * (HI - LO);
}
function fromY(y: number) {
  return Math.max(0, Math.min(1, 1 - y / H));
}

interface Props {
  points: OpacityPoint[];
  onChange: (points: OpacityPoint[]) => void;
  colorPoints?: ColorPoint[];
  onColorChange?: (points: ColorPoint[]) => void;
}

/**
 * Éditeur canvas de la courbe d'opacité (« fenêtrage 3D ») : clic sur le fond =
 * ajout d'un point ; glisser = déplacer ; Maj+clic sur un point = supprimer.
 * Presets perso en localStorage. La couleur reste gérée par le preset clinique.
 */
export default function TransferFunctionEditor({
  points,
  onChange,
  colorPoints,
  onColorChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number | null>(null);
  const [presets, setPresets] = useState<TfPreset[]>([]);

  useEffect(() => {
    setPresets(deserializePresets(localStorage.getItem(LS_KEY)));
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, W, H);
    const pts = normalizeOpacityPoints(points);
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = toX(p.value);
      const y = toY(p.opacity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "#f1f5f9";
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(toX(p.value), toY(p.opacity), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [points]);

  const localPos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitIndex = (x: number, y: number): number => {
    const pts = normalizeOpacityPoints(points);
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(toX(pts[i].value) - x, toY(pts[i].opacity) - y) <= HIT)
        return i;
    }
    return -1;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const { x, y } = localPos(e);
    const idx = hitIndex(x, y);
    const sorted = normalizeOpacityPoints(points);
    if (idx >= 0) {
      if (e.shiftKey) {
        if (sorted.length > 2) onChange(sorted.filter((_, i) => i !== idx));
        return;
      }
      dragRef.current = idx;
      return;
    }
    onChange(
      normalizeOpacityPoints([
        ...sorted,
        { value: fromX(x), opacity: fromY(y) },
      ])
    );
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current === null) return;
    const { x, y } = localPos(e);
    const sorted = normalizeOpacityPoints(points);
    const moved = sorted.map((p, i) =>
      i === dragRef.current ? { value: fromX(x), opacity: fromY(y) } : p
    );
    onChange(normalizeOpacityPoints(moved));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const savePreset = () => {
    const name = window.prompt("Nom du preset d'opacité ?")?.trim();
    if (!name) return;
    const next = [
      ...presets.filter(p => p.name !== name),
      { name, points: normalizeOpacityPoints(points) },
    ];
    setPresets(next);
    try {
      localStorage.setItem(LS_KEY, serializePresets(next));
    } catch {}
  };

  const loadPreset = (name: string) => {
    const p = presets.find(x => x.name === name);
    if (p) onChange(normalizeOpacityPoints(p.points));
  };

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="border border-border rounded cursor-crosshair"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        title="Clic = ajouter un point ; glisser = déplacer ; Maj+clic = supprimer"
      />
      <div className="flex items-center gap-1 text-[10px]">
        <button type="button" className="toolbar-btn" onClick={savePreset}>
          Enregistrer preset
        </button>
        <select
          className="bg-muted/40 border border-border rounded px-1 py-0.5"
          value=""
          onChange={e => e.target.value && loadPreset(e.target.value)}
        >
          <option value="">Mes presets…</option>
          {presets.map(p => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => onChange(defaultOpacityRamp(LO + 200, HI - 1800))}
          title="Réinitialiser la courbe (rampe par défaut)"
        >
          Réinit.
        </button>
      </div>
      {onColorChange && (
        <div className="mt-2 border-t border-border pt-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Couleurs</span>
            <button
              type="button"
              className="text-[10px] px-1 rounded bg-muted/50 hover:bg-muted"
              onClick={() =>
                onColorChange(
                  normalizeColorPoints(
                    (colorPoints && colorPoints.length
                      ? colorPoints
                      : defaultColorPoints(-1000, 1000)
                    ).concat({ value: 0, r: 1, g: 1, b: 0 })
                  )
                )
              }
            >
              + couleur
            </button>
          </div>
          {(colorPoints ?? []).map((cp, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="number"
                className="w-16 bg-muted/40 border border-border rounded text-[10px] px-1"
                value={Math.round(cp.value)}
                onChange={e => {
                  const next = (colorPoints ?? []).slice();
                  next[i] = { ...cp, value: Number(e.target.value) };
                  onColorChange(normalizeColorPoints(next));
                }}
                title="Valeur HU"
              />
              <input
                type="color"
                value={rgb01ToHex(cp.r, cp.g, cp.b)}
                onChange={e => {
                  const c = hexToRgb01(e.target.value);
                  const next = (colorPoints ?? []).slice();
                  next[i] = { value: cp.value, ...c };
                  onColorChange(normalizeColorPoints(next));
                }}
              />
              <button
                type="button"
                className="text-[10px] text-destructive"
                onClick={() =>
                  onColorChange((colorPoints ?? []).filter((_, j) => j !== i))
                }
                title="Supprimer"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
