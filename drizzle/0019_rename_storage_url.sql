-- Rename /manus-storage/ prefix to /storage/ in instances.storageUrl.
-- The proxy still serves both paths for backward compat during transition.
UPDATE `instances`
SET `storageUrl` = REPLACE(`storageUrl`, '/manus-storage/', '/storage/')
WHERE `storageUrl` LIKE '/manus-storage/%';
