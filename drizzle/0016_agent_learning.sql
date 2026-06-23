ALTER TABLE `agent_suggestions` ADD COLUMN `kind` enum('improvement','rag_fiche') NOT NULL DEFAULT 'improvement';
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `modality` varchar(16);
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedHeading` varchar(512);
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `proposedContent` text;
--> statement-breakpoint
ALTER TABLE `agent_suggestions` ADD COLUMN `sampleCount` int;
