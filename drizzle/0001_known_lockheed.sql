CREATE TABLE `album_studies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`albumId` int NOT NULL,
	`studyId` int NOT NULL,
	`addedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `album_studies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` text,
	`userId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `albums_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`instanceId` int NOT NULL,
	`userId` int NOT NULL,
	`type` enum('length','angle','rect_roi','ellipse_roi','text') NOT NULL,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `annotations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `instances` (
	`id` int AUTO_INCREMENT NOT NULL,
	`seriesId` int NOT NULL,
	`sopInstanceUid` varchar(128) NOT NULL,
	`instanceNumber` int,
	`storageKey` varchar(512) NOT NULL,
	`storageUrl` varchar(1024),
	`rows` int,
	`columns` int,
	`bitsAllocated` int,
	`windowCenter` varchar(64),
	`windowWidth` varchar(64),
	`fileSize` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `instances_id` PRIMARY KEY(`id`),
	CONSTRAINT `instances_sopInstanceUid_unique` UNIQUE(`sopInstanceUid`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('new_study','stat_urgent','report_finalized') NOT NULL,
	`title` varchar(256) NOT NULL,
	`message` text,
	`studyId` int,
	`isRead` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `patients` (
	`id` int AUTO_INCREMENT NOT NULL,
	`patientId` varchar(128) NOT NULL,
	`patientName` varchar(256) NOT NULL,
	`birthDate` varchar(10),
	`sex` varchar(2),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `patients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` int AUTO_INCREMENT NOT NULL,
	`studyId` int NOT NULL,
	`seriesInstanceUid` varchar(128) NOT NULL,
	`seriesNumber` int,
	`seriesDescription` text,
	`modality` varchar(16),
	`bodyPart` varchar(64),
	`numberOfInstances` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `series_id` PRIMARY KEY(`id`),
	CONSTRAINT `series_seriesInstanceUid_unique` UNIQUE(`seriesInstanceUid`)
);
--> statement-breakpoint
CREATE TABLE `studies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`patientId` int NOT NULL,
	`studyInstanceUid` varchar(128) NOT NULL,
	`studyDate` varchar(10),
	`studyTime` varchar(16),
	`studyDescription` text,
	`accessionNumber` varchar(64),
	`referringPhysician` varchar(256),
	`performingPhysician` varchar(256),
	`institution` varchar(256),
	`modality` varchar(16),
	`numberOfSeries` int DEFAULT 0,
	`numberOfInstances` int DEFAULT 0,
	`priority` enum('routine','stat','urgent') DEFAULT 'routine',
	`status` enum('new','in_progress','reported','finalized') DEFAULT 'new',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `studies_id` PRIMARY KEY(`id`),
	CONSTRAINT `studies_studyInstanceUid_unique` UNIQUE(`studyInstanceUid`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','radiologist','technician') NOT NULL DEFAULT 'user';