CREATE TABLE `ai_evaluations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`studyId` int NOT NULL,
	`userId` int NOT NULL,
	`model` varchar(128),
	`modality` varchar(16),
	`aiAbnormal` boolean,
	`aiConclusion` text,
	`verdict` enum('juste','partielle','fausse'),
	`missedFinding` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`evaluatedAt` timestamp,
	CONSTRAINT `ai_evaluations_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_evaluations_studyId_unique` UNIQUE(`studyId`)
);
