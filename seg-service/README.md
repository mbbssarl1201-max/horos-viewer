# totalseg-cpu — service de segmentation (TotalSegmentator, CPU)

Source **rapatriée telle quelle depuis la prod** le 22.08.2026
(`/opt/medical/totalseg-cpu/` sur le VPS72, conteneur `totalseg-cpu`, port
8090, en service depuis le 17.08.2026). Ce dossier versionne la référence —
tout changement doit être déployé là-bas.

Contrat (consommé par `server/report/ctSegmentation.ts`) :

    POST /segment?fast=0|1&overlay=N&task=total
      header  X-Seg-Token
      corps   multipart « file » = zip de coupes .dcm (ou NIfTI direct)
      →       {durationS, count, structures: [{name, volumeMl}], overlays, task}

Pipeline : zip → dcm2niix → TotalSegmentator `--statistics` (`--fast` par
défaut, CPU) → volumes en mL (+ overlays PNG optionnels). Un job à la fois
(verrou). `GET /health` pour la sonde. Réseau interne uniquement — les DICOM
ne quittent pas le VPS.
