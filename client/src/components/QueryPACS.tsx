import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Server, Download, Loader2, Trash2, Plus, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface QueryPACSProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function QueryPACS({ open, onOpenChange }: QueryPACSProps) {
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [queryParams, setQueryParams] = useState({
    patientName: "",
    patientId: "",
    studyDate: "",
    modality: "",
    accessionNumber: "",
  });
  const [showAddForm, setShowAddForm] = useState(false);

  // tRPC hooks
  const { data: pacsServers, refetch: refetchServers } = trpc.pacsServers.list.useQuery();
  const { data: orthancStatus } = trpc.orthanc.status.useQuery();
  const queryStudies = trpc.orthanc.queryStudies.useMutation();
  const cMoveMutation = trpc.orthanc.cMove.useMutation();
  const createServer = trpc.pacsServers.create.useMutation({
    onSuccess: () => { refetchServers(); toast.success("Server added"); setShowAddForm(false); },
  });
  const deleteServer = trpc.pacsServers.delete.useMutation({
    onSuccess: () => { refetchServers(); toast.success("Server removed"); },
  });

  const handleSearch = async () => {
    setSearching(true);
    try {
      const params: any = {};
      if (queryParams.patientName) params.patientName = queryParams.patientName;
      if (queryParams.patientId) params.patientId = queryParams.patientId;
      if (queryParams.studyDate) params.studyDate = queryParams.studyDate.replace(/-/g, "");
      if (queryParams.modality && queryParams.modality !== "any") params.modality = queryParams.modality;
      if (queryParams.accessionNumber) params.accessionNumber = queryParams.accessionNumber;

      const response = await queryStudies.mutateAsync(params);
      if (response.success) {
        setResults(response.results || []);
        if ((response.results || []).length === 0) {
          toast("No studies found matching your criteria");
        }
      } else {
        toast.error(response.error || "Query failed - check Orthanc connection");
        setResults([]);
      }
    } catch (err: any) {
      toast.error(err.message || "Query failed - Orthanc server may be unreachable");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleRetrieve = async (studyUid: string) => {
    try {
      const firstServer = (pacsServers || [])[0];
      if (!firstServer) {
        toast.error("No PACS server configured for C-MOVE");
        return;
      }
      await cMoveMutation.mutateAsync({
        sourceAet: firstServer.aeTitle,
        targetAet: "HOROS",
        studyInstanceUID: studyUid,
      });
      toast.success("C-MOVE retrieve initiated");
    } catch (err: any) {
      toast.error(err.message || "Retrieve failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="w-5 h-5 text-primary" />
            Query PACS Server
            {orthancStatus?.connected ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive" />
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="query">
          <TabsList className="w-full">
            <TabsTrigger value="query" className="flex-1">Query (C-FIND)</TabsTrigger>
            <TabsTrigger value="servers" className="flex-1">PACS Servers ({(pacsServers || []).length})</TabsTrigger>
          </TabsList>

          <TabsContent value="query" className="space-y-4">
            {/* Query Form */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Patient Name</Label>
                <Input
                  placeholder="e.g., SMITH*"
                  value={queryParams.patientName}
                  onChange={(e) => setQueryParams({ ...queryParams, patientName: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Patient ID</Label>
                <Input
                  placeholder="e.g., 12345"
                  value={queryParams.patientId}
                  onChange={(e) => setQueryParams({ ...queryParams, patientId: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Study Date</Label>
                <Input
                  type="date"
                  value={queryParams.studyDate}
                  onChange={(e) => setQueryParams({ ...queryParams, studyDate: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Modality</Label>
                <Select
                  value={queryParams.modality}
                  onValueChange={(v) => setQueryParams({ ...queryParams, modality: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any</SelectItem>
                    <SelectItem value="CR">CR</SelectItem>
                    <SelectItem value="CT">CT</SelectItem>
                    <SelectItem value="MR">MR</SelectItem>
                    <SelectItem value="US">US</SelectItem>
                    <SelectItem value="MG">MG</SelectItem>
                    <SelectItem value="RF">RF</SelectItem>
                    <SelectItem value="PT">PT</SelectItem>
                    <SelectItem value="NM">NM</SelectItem>
                    <SelectItem value="XA">XA</SelectItem>
                    <SelectItem value="DR">DR</SelectItem>
                    <SelectItem value="DX">DX</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">Accession Number</Label>
                <Input
                  placeholder="e.g., ACC001"
                  value={queryParams.accessionNumber}
                  onChange={(e) => setQueryParams({ ...queryParams, accessionNumber: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
              {searching ? "Searching..." : "Search PACS (QIDO-RS / C-FIND)"}
            </Button>

            {/* Results */}
            {results.length > 0 && (
              <div className="border rounded-md overflow-hidden">
                <div className="bg-card p-2 text-xs font-medium border-b">
                  {results.length} results found
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {results.map((result: any, idx: number) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2 border-b last:border-0 hover:bg-accent/50"
                    >
                      <div className="text-xs">
                        <p className="font-medium">{result.PatientName || result.patientName || "Unknown"}</p>
                        <p className="text-muted-foreground">
                          {result.StudyDescription || result.studyDescription || "No description"} — {result.Modality || result.modality || "?"}
                        </p>
                        <p className="text-[10px] text-muted-foreground/60 font-mono">
                          {result.StudyInstanceUID || result.studyInstanceUID || ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRetrieve(result.StudyInstanceUID || result.studyInstanceUID || "")}
                        className="gap-1"
                      >
                        <Download className="w-3 h-3" />
                        Retrieve
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {results.length === 0 && !searching && (
              <div className="text-center py-6 text-xs text-muted-foreground">
                <Server className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Enter search criteria and click Search to query the PACS server</p>
                <p className="mt-1 text-[10px]">Supports DICOM C-FIND with wildcard (*) matching via Orthanc DICOMweb</p>
                {!orthancStatus?.connected && (
                  <p className="mt-2 text-destructive text-[10px]">
                    Orthanc server not connected. Configure ORTHANC_URL in environment settings.
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="servers" className="space-y-4">
            {/* Server List */}
            {(pacsServers || []).length > 0 ? (
              <div className="space-y-2">
                {(pacsServers || []).map((srv: any) => (
                  <div key={srv.id} className="flex items-center justify-between p-3 rounded bg-card border text-xs">
                    <div>
                      <p className="font-medium text-foreground">{srv.name}</p>
                      <p className="text-muted-foreground">AE: {srv.aeTitle} | {srv.host}:{srv.port}</p>
                      {srv.orthancUrl && <p className="text-muted-foreground/60 text-[10px]">Orthanc: {srv.orthancUrl}</p>}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteServer.mutate({ id: srv.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-4">
                <Server className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No PACS servers configured</p>
              </div>
            )}

            {/* Add Server Form */}
            {showAddForm ? (
              <form
                className="space-y-3 p-3 border rounded-md bg-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  createServer.mutate({
                    name: fd.get("name") as string,
                    aeTitle: fd.get("aeTitle") as string,
                    host: fd.get("host") as string,
                    port: parseInt(fd.get("port") as string) || 4242,
                    orthancUrl: (fd.get("orthancUrl") as string) || undefined,
                  });
                }}
              >
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px]">Name</Label>
                    <Input name="name" required className="h-7 text-xs" placeholder="MAC-IRM" />
                  </div>
                  <div>
                    <Label className="text-[10px]">AE Title</Label>
                    <Input name="aeTitle" required className="h-7 text-xs" placeholder="HOROS" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Host</Label>
                    <Input name="host" required className="h-7 text-xs" placeholder="192.168.1.100" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Port</Label>
                    <Input name="port" type="number" defaultValue="4242" className="h-7 text-xs" />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-[10px]">Orthanc URL (optional)</Label>
                    <Input name="orthancUrl" className="h-7 text-xs" placeholder="http://localhost:8042" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" className="flex-1">Add</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setShowAddForm(true)}
              >
                <Plus className="w-4 h-4" />
                Add PACS Server
              </Button>
            )}

            {/* Orthanc Status */}
            <div className="p-3 rounded bg-card border text-xs">
              <p className="font-medium text-foreground flex items-center gap-2">
                Orthanc Connection Status
                {orthancStatus?.connected ? (
                  <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-destructive" />
                )}
              </p>
              <p className="text-muted-foreground mt-1">
                {orthancStatus?.connected
                  ? `Connected to Orthanc server`
                  : "Not connected - configure ORTHANC_URL, ORTHANC_USER, ORTHANC_PASSWORD in environment"}
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
