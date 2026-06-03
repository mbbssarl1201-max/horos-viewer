CREATE TABLE `pacs_servers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`aeTitle` varchar(64) NOT NULL,
	`host` varchar(256) NOT NULL,
	`port` int NOT NULL DEFAULT 4242,
	`orthancUrl` varchar(512),
	`isDefault` int NOT NULL DEFAULT 0,
	`userId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pacs_servers_id` PRIMARY KEY(`id`)
);
