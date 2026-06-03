CREATE INDEX `album_studies_albumId_idx` ON `album_studies` (`albumId`);--> statement-breakpoint
CREATE INDEX `album_studies_studyId_idx` ON `album_studies` (`studyId`);--> statement-breakpoint
CREATE INDEX `albums_userId_idx` ON `albums` (`userId`);--> statement-breakpoint
CREATE INDEX `annotations_instanceId_idx` ON `annotations` (`instanceId`);--> statement-breakpoint
CREATE INDEX `annotations_userId_idx` ON `annotations` (`userId`);--> statement-breakpoint
CREATE INDEX `instances_seriesId_idx` ON `instances` (`seriesId`);--> statement-breakpoint
CREATE INDEX `notifications_userId_idx` ON `notifications` (`userId`);--> statement-breakpoint
CREATE INDEX `notifications_studyId_idx` ON `notifications` (`studyId`);--> statement-breakpoint
CREATE INDEX `pacs_servers_userId_idx` ON `pacs_servers` (`userId`);--> statement-breakpoint
CREATE INDEX `patients_patientId_idx` ON `patients` (`patientId`);--> statement-breakpoint
CREATE INDEX `series_studyId_idx` ON `series` (`studyId`);--> statement-breakpoint
CREATE INDEX `studies_patientId_idx` ON `studies` (`patientId`);--> statement-breakpoint
CREATE INDEX `studies_createdAt_idx` ON `studies` (`createdAt`);