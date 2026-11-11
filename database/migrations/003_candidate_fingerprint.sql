CREATE UNIQUE INDEX ai_source_fingerprint ON obligations(json_extract(data,'$.source_fingerprint')) WHERE json_extract(data,'$.source_fingerprint') IS NOT NULL;
