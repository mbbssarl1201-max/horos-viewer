CREATE TABLE `ai_jobs` (
	`id` varchar(64) NOT NULL,
	`studyId` int NOT NULL,
	`status` enum('running','done','error') NOT NULL DEFAULT 'running',
	`progressDone` int NOT NULL DEFAULT 0,
	`progressTotal` int NOT NULL DEFAULT 0,
	`result` json,
	`error` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ai_jobs_study_idx` ON `ai_jobs` (`studyId`);
