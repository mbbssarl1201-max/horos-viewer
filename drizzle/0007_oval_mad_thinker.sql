CREATE TABLE `report_addenda` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reportId` int NOT NULL,
	`text` text NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `report_addenda_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`studyId` int NOT NULL,
	`status` enum('draft','signed') NOT NULL DEFAULT 'draft',
	`indication` text,
	`technique` text,
	`resultats` text,
	`conclusion` text,
	`aiGenerated` boolean NOT NULL DEFAULT false,
	`aiModel` varchar(128),
	`createdBy` int NOT NULL,
	`signedBy` int,
	`signedAt` timestamp,
	`pdfStorageKey` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `reports_studyId_unique` UNIQUE(`studyId`)
);
