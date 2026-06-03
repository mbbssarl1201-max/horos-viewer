import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Shield, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface AnonymizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studyId?: number;
}

const ANONYMIZE_FIELDS = [
  { id: "patientName", label: "Patient Name", tag: "(0010,0010)", critical: true },
  { id: "patientId", label: "Patient ID", tag: "(0010,0020)", critical: true },
  { id: "birthDate", label: "Date of Birth", tag: "(0010,0030)", critical: true },
  { id: "address", label: "Patient Address", tag: "(0010,1040)", critical: true },
  { id: "phone", label: "Phone Number", tag: "(0010,2154)", critical: true },
  { id: "referringPhysician", label: "Referring Physician", tag: "(0008,0090)", critical: false },
  { id: "institution", label: "Institution Name", tag: "(0008,0080)", critical: false },
  { id: "accessionNumber", label: "Accession Number", tag: "(0008,0050)", critical: false },
  { id: "studyId", label: "Study ID", tag: "(0020,0010)", critical: false },
];

export default function AnonymizeDialog({ open, onOpenChange, studyId }: AnonymizeDialogProps) {
  const [selectedFields, setSelectedFields] = useState<string[]>(
    ANONYMIZE_FIELDS.filter((f) => f.critical).map((f) => f.id)
  );
  const [processing, setProcessing] = useState(false);

  const toggleField = (fieldId: string) => {
    setSelectedFields((prev) =>
      prev.includes(fieldId) ? prev.filter((f) => f !== fieldId) : [...prev, fieldId]
    );
  };

  const anonymizeMutation = trpc.studies.anonymize.useMutation({
    onSuccess: (data) => {
      toast.success(`Study anonymized: ${data.fieldsAnonymized} field(s) cleared`);
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message || "Anonymization failed");
    },
  });

  const handleAnonymize = async () => {
    if (!studyId) {
      toast.error("No study selected");
      return;
    }
    setProcessing(true);
    try {
      await anonymizeMutation.mutateAsync({ id: studyId, fields: selectedFields });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            Anonymize DICOM Data
          </DialogTitle>
          <DialogDescription>
            Remove patient-identifying information from DICOM metadata before sharing or exporting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 border border-destructive/20">
            <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-[11px] text-destructive">
              This action will permanently remove selected metadata from stored DICOM files.
              This cannot be undone.
            </p>
          </div>

          <div className="space-y-2">
            {ANONYMIZE_FIELDS.map((field) => (
              <div
                key={field.id}
                className="flex items-center gap-3 p-2 rounded hover:bg-accent/50"
              >
                <Checkbox
                  id={field.id}
                  checked={selectedFields.includes(field.id)}
                  onCheckedChange={() => toggleField(field.id)}
                />
                <Label htmlFor={field.id} className="flex-1 cursor-pointer">
                  <div className="flex items-center justify-between">
                    <span className="text-xs">{field.label}</span>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {field.tag}
                    </span>
                  </div>
                </Label>
                {field.critical && (
                  <span className="text-[8px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">
                    PII
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 gap-2"
              onClick={handleAnonymize}
              disabled={processing || selectedFields.length === 0}
            >
              <Shield className="w-4 h-4" />
              {processing ? "Processing..." : "Anonymize"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
