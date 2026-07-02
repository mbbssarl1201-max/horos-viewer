CREATE TABLE `referring_contacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(256) NOT NULL,
	`email` varchar(256) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `referring_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `referring_contacts_name_idx` ON `referring_contacts` (`name`);
--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`id` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`enabledAt` timestamp NULL,
	`dailyCap` int NOT NULL DEFAULT 20,
	`lastRunAt` timestamp NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
INSERT INTO `agent_settings` (`id`, `enabled`, `dailyCap`) VALUES (1, false, 20);
