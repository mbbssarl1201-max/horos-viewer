-- Migration 0018 : Liens OTP sécurisés pour partage de CR aux référents.
-- Token UUID v4, expiré après 7 jours, usage unique.
CREATE TABLE `report_share_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `token` varchar(64) NOT NULL,
  `reportId` int NOT NULL,
  `studyId` int NOT NULL,
  `recipientEmail` varchar(255) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `usedAt` timestamp NULL DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `report_share_tokens_token_unique` (`token`),
  KEY `report_share_tokens_reportId_idx` (`reportId`),
  KEY `report_share_tokens_expiresAt_idx` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
