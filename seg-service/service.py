"""
totalseg-service v4 — segmentation CT (TotalSegmentator) multi-tâches + overlays.

?task=total | head_glands_cavities | headneck_bones_vessels | brain_structures ...
?fast=1|0   (uniquement pour la tâche "total")
?overlay=N  (coupes composites CT + masques colorés, base64 PNG)
→ { durationS, count, structures:[{name,volumeMl}], overlays:[{sliceIndex,pngBase64}] }
"""
import base64
import glob
import hmac
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import zipfile

import numpy as np
from flask import Flask, request, jsonify

TOKEN = os.environ.get("SEG_TOKEN", "")
TSEG = os.environ.get("TSEG_BIN", "TotalSegmentator")
ALLOWED_TASKS = {
    "total",
    "total_mr",
    "head_glands_cavities",
    "headneck_bones_vessels",
    "head_muscles",
    "headneck_muscles",
    "brain_structures",
}
gpu_lock = threading.Lock()
app = Flask(__name__)

_PALETTE = [
    (255, 80, 80), (80, 180, 255), (120, 220, 120), (255, 200, 60),
    (200, 120, 255), (80, 220, 220), (255, 140, 60), (160, 160, 255),
    (255, 110, 180), (140, 230, 90), (90, 160, 230), (230, 200, 120),
    (200, 90, 90), (90, 200, 160), (180, 140, 220), (230, 160, 90),
]


def _check():
    # Fail-closed (jeton OBLIGATOIRE) + comparaison en temps constant.
    return bool(TOKEN) and hmac.compare_digest(
        request.headers.get("X-Seg-Token", ""), TOKEN
    )


def _window(img, c=40.0, w=400.0):
    lo, hi = c - w / 2, c + w / 2
    return np.clip((img - lo) / (hi - lo), 0, 1)


def _make_overlays(ct_path, out_dir, present, n):
    import nibabel as nib
    from PIL import Image

    ct = nib.as_closest_canonical(nib.load(ct_path))
    ctd = ct.get_fdata()
    lab = np.zeros(ctd.shape, dtype=np.int16)
    color_of = {}
    idx = 0
    for name in present:
        p = os.path.join(out_dir, name + ".nii.gz")
        if not os.path.exists(p):
            continue
        md = np.asarray(nib.as_closest_canonical(nib.load(p)).dataobj)
        if md.shape != ctd.shape:
            continue
        idx += 1
        lab[md > 0.5] = idx
        color_of[idx] = _PALETTE[idx % len(_PALETTE)]
    zmask = lab.any(axis=(0, 1))
    zs = np.where(zmask)[0]
    if len(zs) == 0:
        return []
    sel = np.unique(np.linspace(zs[0], zs[-1], n).astype(int))
    out = []
    for z in sel:
        base = (_window(ctd[:, :, z]) * 255).astype(np.uint8)
        rgb = np.stack([base, base, base], axis=-1).astype(np.float32)
        sl = lab[:, :, z]
        for L in np.unique(sl):
            if L <= 0:
                continue
            color = np.array(color_of.get(int(L), (255, 0, 0)), dtype=np.float32)
            m = sl == L
            rgb[m] = 0.5 * color + 0.5 * rgb[m]
        disp = np.flipud(np.transpose(rgb.astype(np.uint8), (1, 0, 2)))
        buf = io.BytesIO()
        Image.fromarray(disp).save(buf, format="PNG")
        out.append({"sliceIndex": int(z), "pngBase64": base64.b64encode(buf.getvalue()).decode()})
    return out


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/segment")
def segment():
    if not _check():
        return jsonify({"error": "unauthorized"}), 401
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "no file"}), 400
    fast = request.args.get("fast", "1") != "0"
    n_overlay = int(request.args.get("overlay", "0") or 0)
    task = request.args.get("task", "total")
    if task not in ALLOWED_TASKS:
        task = "total"
    with tempfile.TemporaryDirectory() as d:
        raw = os.path.join(d, f.filename or "input")
        f.save(raw)
        if raw.endswith(".zip"):
            ddir = os.path.join(d, "dicom")
            os.makedirs(ddir, exist_ok=True)
            with zipfile.ZipFile(raw) as z:
                # Anti zip-slip : jamais d'extraction hors du dossier cible.
                root = os.path.realpath(ddir)
                for member in z.namelist():
                    dest = os.path.realpath(os.path.join(ddir, member))
                    if not dest.startswith(root + os.sep) or member.endswith("/"):
                        continue
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with z.open(member) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
            subprocess.run(
                ["dcm2niix", "-z", "y", "-o", d, "-f", "vol", ddir],
                capture_output=True, timeout=300,
            )
            niis = sorted(glob.glob(os.path.join(d, "*.nii.gz")), key=os.path.getsize)
            if not niis:
                return jsonify({"error": "conversion DICOM->NIfTI échouée"}), 422
            nii = niis[-1]
        else:
            nii = raw
        out = os.path.join(d, "out")
        cmd = [TSEG, "-i", nii, "-o", out, "--statistics", "--task", task]
        if fast and task == "total":
            cmd.append("--fast")
        with gpu_lock:
            t0 = time.time()
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
            dt = round(time.time() - t0)
        statf = os.path.join(out, "statistics.json")
        if not os.path.exists(statf):
            return jsonify({"error": "segmentation échouée", "log": p.stderr[-500:]}), 500
        s = json.load(open(statf))
        structs = []
        for k, v in s.items():
            if isinstance(v, dict):
                vol = v.get("volume", 0) or 0
                if vol > 0:
                    structs.append({"name": k, "volumeMl": round(vol / 1000, 1)})
        structs.sort(key=lambda x: -x["volumeMl"])
        overlays = []
        if n_overlay > 0:
            try:
                overlays = _make_overlays(nii, out, [x["name"] for x in structs], n_overlay)
            except Exception as e:  # noqa
                print("[overlay] échec:", repr(e)[:300], flush=True)
        return jsonify({"durationS": dt, "count": len(structs), "structures": structs, "overlays": overlays, "task": task})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8090, threaded=True)
