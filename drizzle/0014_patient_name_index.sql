ALTER TABLE `patients` ADD COLUMN `nameSearch` varchar(255);
CREATE INDEX `patients_nameSearch_idx` ON `patients` (`nameSearch`);
