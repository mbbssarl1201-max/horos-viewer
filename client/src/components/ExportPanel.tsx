import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Download, Image, FileText, Film, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ExportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studyId?: number;
  viewportElement?: HTMLElement | null;
}

export default function ExportPanel({
  open,
  onOpenChange,
  studyId,
  viewportElement,
}: ExportPanelProps) {
  const [exportFormat, setExportFormat] = useState("png");
  const [exporting, setExporting] = useState(false);

  // Téléchargement NON BLOQUANT : un gros export ZIP (centaines de fichiers
  // assemblés côté serveur depuis MinIO) peut durer un moment. On laisse le
  // GESTIONNAIRE DE TÉLÉCHARGEMENTS du navigateur s'en charger (barre de
  // progression, sans figer l'UI). Le nom + l'extension sont fixés par l'attribut
  // `download` ET confirmés par l'en-tête Content-Disposition du serveur — donc
  // plus de fichier sans extension (nom = UUID).
  const triggerDownload = (url: string, filename: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      if (exportFormat === "png" || exportFormat === "jpeg") {
        if (viewportElement) {
          const canvas = viewportElement.querySelector("canvas");
          if (canvas) {
            const mimeType =
              exportFormat === "png" ? "image/png" : "image/jpeg";
            const dataUrl = canvas.toDataURL(mimeType);
            const link = document.createElement("a");
            link.download = `dicom_export.${exportFormat}`;
            link.href = dataUrl;
            link.click();
            toast.success(`Image exported as ${exportFormat.toUpperCase()}`);
          } else {
            toast.error("No viewport canvas found");
          }
        } else {
          toast.error("No viewport available for capture");
        }
      } else if (exportFormat === "dicom") {
        if (!studyId) {
          toast.error("No study selected for DICOM export");
          return;
        }
        triggerDownload(
          `/api/export/dicom-zip/${studyId}`,
          `etude_${studyId}_dicom.zip`
        );
        toast.success(
          "Téléchargement lancé (voir la barre de téléchargements). Une grosse étude peut prendre un moment."
        );
      } else if (exportFormat === "pdf") {
        if (!studyId) {
          toast.error("No study selected for PDF report");
          return;
        }
        triggerDownload(
          `/api/export/pdf-report/${studyId}`,
          `rapport_etude_${studyId}.pdf`
        );
        toast.success("Rapport PDF — téléchargement lancé");
      }
    } catch (err: any) {
      toast.error(err.message || "Échec de l'export");
    } finally {
      setExporting(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Export Study</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <RadioGroup value={exportFormat} onValueChange={setExportFormat}>
            <div className="flex items-center space-x-3 p-2 rounded hover:bg-accent/50">
              <RadioGroupItem value="png" id="png" />
              <Label
                htmlFor="png"
                className="flex items-center gap-2 cursor-pointer flex-1"
              >
                <Image className="w-4 h-4 text-primary" />
                <div>
                  <p className="text-sm">PNG Image</p>
                  <p className="text-[10px] text-muted-foreground">
                    Lossless screenshot of current view
                  </p>
                </div>
              </Label>
            </div>
            <div className="flex items-center space-x-3 p-2 rounded hover:bg-accent/50">
              <RadioGroupItem value="jpeg" id="jpeg" />
              <Label
                htmlFor="jpeg"
                className="flex items-center gap-2 cursor-pointer flex-1"
              >
                <Image className="w-4 h-4 text-green-400" />
                <div>
                  <p className="text-sm">JPEG Image</p>
                  <p className="text-[10px] text-muted-foreground">
                    Compressed screenshot of current view
                  </p>
                </div>
              </Label>
            </div>
            <div className="flex items-center space-x-3 p-2 rounded hover:bg-accent/50">
              <RadioGroupItem value="dicom" id="dicom" />
              <Label
                htmlFor="dicom"
                className="flex items-center gap-2 cursor-pointer flex-1"
              >
                <Film className="w-4 h-4 text-yellow-400" />
                <div>
                  <p className="text-sm">DICOM ZIP Archive</p>
                  <p className="text-[10px] text-muted-foreground">
                    All series files bundled in a ZIP
                  </p>
                </div>
              </Label>
            </div>
            <div className="flex items-center space-x-3 p-2 rounded hover:bg-accent/50">
              <RadioGroupItem value="pdf" id="pdf" />
              <Label
                htmlFor="pdf"
                className="flex items-center gap-2 cursor-pointer flex-1"
              >
                <FileText className="w-4 h-4 text-red-400" />
                <div>
                  <p className="text-sm">PDF Report</p>
                  <p className="text-[10px] text-muted-foreground">
                    Structured radiology report document
                  </p>
                </div>
              </Label>
            </div>
          </RadioGroup>

          <Button
            className="w-full gap-2"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {exporting ? "Exporting..." : "Export"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
