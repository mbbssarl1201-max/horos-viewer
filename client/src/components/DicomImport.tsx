import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Upload, FileCheck, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface DicomImportProps {
  onComplete?: () => void;
}

export default function DicomImport({ onComplete }: DicomImportProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [processedFiles, setProcessedFiles] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const importMutation = trpc.dicom.import.useMutation();
  const utils = trpc.useUtils();

  const parseDicomFile = async (file: File): Promise<any> => {
    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);

    // Use dicom-parser to extract metadata
    // We'll do a simplified parse here - the actual parsing happens client-side
    try {
      const { default: dicomParser } = await import("dicom-parser");
      const dataSet = dicomParser.parseDicom(byteArray);

      // Extract DICOM tags
      const getString = (tag: string) => {
        try {
          return dataSet.string(tag) || undefined;
        } catch {
          return undefined;
        }
      };

      const getInt = (tag: string) => {
        try {
          return dataSet.uint16(tag) || undefined;
        } catch {
          return undefined;
        }
      };

      return {
        patientId: getString("x00100020") || "UNKNOWN",
        patientName: getString("x00100010") || "Unknown Patient",
        birthDate: getString("x00100030"),
        sex: getString("x00100040"),
        studyInstanceUid: getString("x0020000d") || crypto.randomUUID(),
        studyDate: getString("x00080020"),
        studyTime: getString("x00080030"),
        studyDescription: getString("x00081030"),
        accessionNumber: getString("x00080050"),
        referringPhysician: getString("x00080090"),
        performingPhysician: getString("x00081050"),
        institution: getString("x00080080"),
        modality: getString("x00080060"),
        seriesInstanceUid: getString("x0020000e") || crypto.randomUUID(),
        seriesNumber: parseInt(getString("x00200011") || "1"),
        seriesDescription: getString("x0008103e"),
        bodyPart: getString("x00180015"),
        sopInstanceUid: getString("x00080018") || crypto.randomUUID(),
        instanceNumber: parseInt(getString("x00200013") || "1"),
        rows: getInt("x00280010"),
        columns: getInt("x00280011"),
        bitsAllocated: getInt("x00280100"),
        windowCenter: getString("x00281050"),
        windowWidth: getString("x00281051"),
        fileSize: file.size,
      };
    } catch (err) {
      console.error("DICOM parse error:", err);
      throw new Error(`Failed to parse DICOM file: ${file.name}`);
    }
  };

  const processFiles = async (files: File[]) => {
    setImporting(true);
    setTotalFiles(files.length);
    setProcessedFiles(0);
    setErrors([]);
    setProgress(0);

    const dicomFiles = files.filter(
      (f) =>
        f.name.endsWith(".dcm") ||
        f.name.endsWith(".dicom") ||
        f.type === "application/dicom" ||
        !f.name.includes(".") // DICOM files often have no extension
    );

    if (dicomFiles.length === 0) {
      setErrors(["No valid DICOM files found"]);
      setImporting(false);
      return;
    }

    setTotalFiles(dicomFiles.length);

    for (let i = 0; i < dicomFiles.length; i++) {
      try {
        const file = dicomFiles[i];
        const metadata = await parseDicomFile(file);

        // Convert file to base64
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
        );

        await importMutation.mutateAsync({
          ...metadata,
          fileData: base64,
        });

        setProcessedFiles(i + 1);
        setProgress(((i + 1) / dicomFiles.length) * 100);
      } catch (err: any) {
        setErrors((prev) => [...prev, err.message || `Error processing file ${i + 1}`]);
      }
    }

    // Invalidate studies list to refresh
    await utils.studies.list.invalidate();
    setImporting(false);
    onComplete?.();
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const items = e.dataTransfer.items;
      const files: File[] = [];

      // Handle directory drops
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          if (entry.isDirectory) {
            const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry);
            files.push(...dirFiles);
          } else {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        } else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        await processFiles(files);
      }
    },
    [importMutation]
  );

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await processFiles(files);
    }
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        isDragging
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {importing ? (
        <div className="space-y-4">
          <Loader2 className="w-10 h-10 text-primary mx-auto animate-spin" />
          <div>
            <p className="text-sm text-foreground">
              Importing DICOM files...
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {processedFiles} / {totalFiles} files processed
            </p>
          </div>
          <Progress value={progress} className="max-w-xs mx-auto" />
        </div>
      ) : (
        <div className="space-y-4">
          <Upload className="w-10 h-10 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm text-foreground">
              Drag & drop DICOM files or folders here
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Supports .dcm, .dicom files and DICOMDIR folders
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById("dicom-file-input")?.click()}
            >
              Select Files
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById("dicom-folder-input")?.click()}
            >
              Select Folder
            </Button>
          </div>
          <input
            id="dicom-file-input"
            type="file"
            multiple
            accept=".dcm,.dicom,application/dicom"
            className="hidden"
            onChange={handleFileSelect}
          />
          <input
            id="dicom-folder-input"
            type="file"
            multiple
            // @ts-ignore
            webkitdirectory=""
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>
      )}

      {errors.length > 0 && (
        <div className="mt-4 text-left max-w-md mx-auto">
          {errors.slice(0, 5).map((err, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          ))}
          {errors.length > 5 && (
            <p className="text-xs text-muted-foreground mt-1">
              ...and {errors.length - 5} more errors
            </p>
          )}
        </div>
      )}

      {processedFiles > 0 && !importing && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-green-400">
          <FileCheck className="w-4 h-4" />
          <span>{processedFiles} files imported successfully</span>
        </div>
      )}
    </div>
  );
}

// Helper to read directory entries recursively
async function readDirectory(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
  const files: File[] = [];
  const reader = dirEntry.createReader();

  const readEntries = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

  const getFile = (fileEntry: FileSystemFileEntry): Promise<File> =>
    new Promise((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });

  let entries = await readEntries();
  while (entries.length > 0) {
    for (const entry of entries) {
      if (entry.isFile) {
        const file = await getFile(entry as FileSystemFileEntry);
        files.push(file);
      } else if (entry.isDirectory) {
        const subFiles = await readDirectory(entry as FileSystemDirectoryEntry);
        files.push(...subFiles);
      }
    }
    entries = await readEntries();
  }

  return files;
}
