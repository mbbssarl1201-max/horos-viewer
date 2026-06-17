import { trpc } from "@/lib/trpc";
import { Bell, AlertTriangle, FileText, Inbox, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useLocation } from "wouter";

export default function NotificationsPanel() {
  const { data: notifications, isLoading } = trpc.notifications.list.useQuery();
  const markRead = trpc.notifications.markRead.useMutation();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();

  const unreadCount = notifications?.filter((n: any) => !n.isRead).length || 0;

  const handleMarkRead = async (id: number) => {
    await markRead.mutateAsync({ id });
    utils.notifications.list.invalidate();
  };

  // Une notif liée à une étude ouvre l'étude au clic (et la marque lue).
  const handleOpen = async (notif: any) => {
    if (notif.studyId == null) return;
    if (!notif.isRead) {
      await markRead.mutateAsync({ id: notif.id });
      utils.notifications.list.invalidate();
    }
    navigate(`/viewer/${notif.studyId}`);
  };

  const getIcon = (type: string) => {
    switch (type) {
      case "new_study":
        return <Inbox className="w-4 h-4 text-primary" />;
      case "stat_urgent":
        return <AlertTriangle className="w-4 h-4 text-destructive" />;
      case "report_finalized":
        return <FileText className="w-4 h-4 text-green-400" />;
      default:
        return <Bell className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-[9px] text-white flex items-center justify-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="p-3 border-b border-border">
          <h3 className="text-sm font-medium">Notifications</h3>
          <p className="text-xs text-muted-foreground">
            {unreadCount} unread notifications
          </p>
        </div>
        <ScrollArea className="max-h-80">
          {isLoading ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : !notifications || notifications.length === 0 ? (
            <div className="p-6 text-center">
              <Bell className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No notifications</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {notifications.map((notif: any) => (
                <div
                  key={notif.id}
                  className={`p-3 flex gap-3 ${
                    !notif.isRead ? "bg-primary/5" : ""
                  }`}
                >
                  <div className="shrink-0 mt-0.5">{getIcon(notif.type)}</div>
                  <div
                    className={`flex-1 min-w-0 ${
                      notif.studyId != null ? "cursor-pointer" : ""
                    }`}
                    role={notif.studyId != null ? "button" : undefined}
                    onClick={
                      notif.studyId != null
                        ? () => handleOpen(notif)
                        : undefined
                    }
                  >
                    <p className="text-xs font-medium truncate">
                      {notif.title}
                    </p>
                    {notif.message && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                        {notif.message}
                      </p>
                    )}
                    <p className="text-[9px] text-muted-foreground/60 mt-1">
                      {new Date(notif.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {!notif.isRead && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => handleMarkRead(notif.id)}
                    >
                      <Check className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
