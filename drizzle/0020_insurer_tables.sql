-- Migration 0020: Tables SUVA agent (insurer_requests + insurer_bundle_tokens)
-- Demandes d'imagerie d'assureurs reçues sur la boîte dédiée.
-- Jetons de téléchargement du colis DICOM.
CREATE TABLE `insurer_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `messageId` varchar(255) NOT NULL,
  `expediteur` varchar(255) NOT NULL,
  `sujet` varchar(512),
  `recuLe` timestamp NOT NULL,
  `statut` enum('recue','extraite','identifiee','prete','a_valider','envoyee','rejetee','erreur') NOT NULL DEFAULT 'recue',
  `corpsTexte` text,
  `attachmentKeys` json,
  `extraction` json,
  `patientId` int,
  `studyIds` json,
  `adresseReponse` varchar(255),
  `motifValidation` text,
  `envoyeLe` timestamp,
  `envoyePar` int,
  `erreur` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `insurer_requests_messageId_unique` (`messageId`),
  KEY `insurer_requests_statut_idx` (`statut`),
  KEY `insurer_requests_recuLe_idx` (`recuLe`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--> statement-breakpoint

CREATE TABLE `insurer_bundle_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `requestId` int NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `bundleKey` varchar(512) NOT NULL,
  `expireLe` timestamp NOT NULL,
  `telechargements` json,
  `revoqueLe` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `insurer_bundle_tokens_tokenHash_unique` (`tokenHash`),
  KEY `insurer_bundle_tokens_requestId_idx` (`requestId`),
  KEY `insurer_bundle_tokens_expireLe_idx` (`expireLe`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
