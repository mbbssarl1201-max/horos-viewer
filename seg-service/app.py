"""Micro-service TotalSegmentator (CPU) — remplace le service qui vivait sur
l'A100 supprimé. Contrat imposé par le client MediView (ctSegmentation.ts) :

    POST /segment?fast=0|1&overlay=N&task=total
      header  X-Seg-Token: <jeton partagé>
      corps   multipart, champ « file » = zip de coupes .dcm
      →       {durationS, count, structures: [{name, volumeMl}], overlays: []}

Tourne sur CPU : SEG_FORCE_FAST=1 (défaut) force --fast même si fast=0 est
demandé (la haute résolution CPU dépasserait le timeout client de 900 s).
Un seul job à la fois (sémaphore) : 503 « occupé » sinon.
Les DICOM ne quittent jamais la machine (réseau interne uniquement).
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile

from fastapi import FastAPI, HTTPException, Request, UploadFile

app = FastAPI()
_LOCK = threading.Semaphore(1)

SEG_TOKEN = os.environ.get("SEG_TOKEN", "")
FORCE_FAST = os.environ.get("SEG_FORCE_FAST", "1") == "1"
# Marge sous le timeout client (900 s) pour renvoyer une erreur propre.
SUBPROCESS_TIMEOUT_S = int(os.environ.get("SEG_TIMEOUT_S", "840"))


def parse_statistics(stats: dict) -> list[dict]:
    """statistics.json de TotalSegmentator → [{name, volumeMl}] trié par volume
    décroissant, volumes nuls/invalides exclus, arrondi 1 décimale. PURE."""
    out = []
    for name, info in (stats or {}).items():
        vol = (info or {}).get("volume")
        if not isinstance(vol, (int, float)) or vol <= 0:
            continue
        out.append({"name": name, "volumeMl": round(float(vol), 1)})
    out.sort(key=lambda s: -s["volumeMl"])
    return out


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/segment")
async def segment(
    request: Request,
    file: UploadFile,
    fast: int = 1,
    overlay: int = 0,
    task: str = "total",
):
    if not SEG_TOKEN or request.headers.get("X-Seg-Token") != SEG_TOKEN:
        raise HTTPException(status_code=403, detail="jeton invalide")
    if not _LOCK.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="segmentation en cours")
    t0 = time.time()
    tmp = tempfile.mkdtemp(prefix="seg-")
    try:
        zip_path = os.path.join(tmp, "series.zip")
        with open(zip_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        in_dir = os.path.join(tmp, "dicom")
        os.makedirs(in_dir)
        with zipfile.ZipFile(zip_path) as z:
            for member in z.namelist():
                # Anti zip-slip : jamais d'extraction hors du dossier cible.
                dest = os.path.realpath(os.path.join(in_dir, member))
                if not dest.startswith(os.path.realpath(in_dir)):
                    continue
                if member.endswith("/"):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(member) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        out_dir = os.path.join(tmp, "out")
        cmd = [
            "TotalSegmentator",
            "-i",
            in_dir,
            "-o",
            out_dir,
            "--ml",
            "--statistics",
            "-ta",
            task,
        ]
        if fast == 1 or FORCE_FAST:
            cmd.append("--fast")
        try:
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                timeout=SUBPROCESS_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="segmentation trop longue")
        except subprocess.CalledProcessError as e:
            tail = (e.stderr or b"")[-400:].decode("utf-8", "replace")
            raise HTTPException(status_code=500, detail=f"TotalSegmentator: {tail}")
        stats_path = os.path.join(out_dir, "statistics.json")
        if not os.path.exists(stats_path):
            raise HTTPException(status_code=500, detail="statistics.json absent")
        with open(stats_path) as f:
            structures = parse_statistics(json.load(f))
        return {
            "durationS": round(time.time() - t0, 1),
            "count": len(structures),
            "structures": structures,
            # Overlays non générés en CPU (optionnels côté client).
            "overlays": [],
        }
    finally:
        _LOCK.release()
        shutil.rmtree(tmp, ignore_errors=True)
