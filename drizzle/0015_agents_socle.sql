CREATE TABLE `agent_state` (
	`agentKey` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`targetsJson` text,
	`lastRunAt` timestamp NULL,
	`lastError` varchar(512),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_state_agentKey` PRIMARY KEY(`agentKey`)
);
--> statement-breakpoint
CREATE TABLE `agent_activity` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`action` varchar(128) NOT NULL,
	`studyId` int,
	`status` enum('ok','error','skipped') NOT NULL,
	`detail` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_activity_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_activity_agent_idx` ON `agent_activity` (`agentKey`);
--> statement-breakpoint
CREATE TABLE `agent_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`note` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_suggestions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`kpiKey` varchar(64) NOT NULL,
	`gap` int,
	`suggestion` text NOT NULL,
	`status` enum('open','approved','dismissed') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_suggestions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `report_ai_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`studyId` int NOT NULL,
	`sectionsJson` text NOT NULL,
	`model` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `report_ai_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_ai_snapshots_studyId_unique` UNIQUE(`studyId`)
);
