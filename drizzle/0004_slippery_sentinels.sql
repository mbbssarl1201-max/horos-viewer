CREATE TABLE `access_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`action` varchar(64) NOT NULL,
	`studyId` int,
	`detail` varchar(256),
	`ipAddress` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `access_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `access_logs_userId_idx` ON `access_logs` (`userId`);--> statement-breakpoint
CREATE INDEX `access_logs_studyId_idx` ON `access_logs` (`studyId`);--> statement-breakpoint
CREATE INDEX `access_logs_createdAt_idx` ON `access_logs` (`createdAt`);