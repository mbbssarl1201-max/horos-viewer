-- nLPD : chiffrement applicatif au repos des identités patient.
-- Élargit les colonnes pour accueillir le chiffré (base64 IV+tag+ciphertext),
-- plus long que le clair. Le re-chiffrement des lignes existantes est fait par
-- un script de migration de données dédié (hors drizzle).
ALTER TABLE `patients` MODIFY COLUMN `patientId` varchar(512) NOT NULL;
--> statement-breakpoint
ALTER TABLE `patients` MODIFY COLUMN `patientName` varchar(1024) NOT NULL;
--> statement-breakpoint
ALTER TABLE `patients` MODIFY COLUMN `birthDate` varchar(128);
--> statement-breakpoint
ALTER TABLE `patients` MODIFY COLUMN `sex` varchar(64);
