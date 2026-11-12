CREATE TABLE event_drafts (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=1), data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 project_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.project_id')) STORED REFERENCES projects(id),
 document_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.document_id')) STORED REFERENCES documents(id),
 extraction_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.extraction_id')) STORED REFERENCES extractions(id)
);
CREATE UNIQUE INDEX event_drafts_candidate ON event_drafts(extraction_id,json_extract(data,'$.candidate_key'));
CREATE UNIQUE INDEX ai_event_source_fingerprint ON events(json_extract(data,'$.source_fingerprint')) WHERE json_extract(data,'$.source_fingerprint') IS NOT NULL;
CREATE TRIGGER event_drafts_owner_insert BEFORE INSERT ON event_drafts WHEN NOT EXISTS (
 SELECT 1 FROM extractions r JOIN documents d ON d.id=json_extract(NEW.data,'$.document_id')
 WHERE r.id=json_extract(NEW.data,'$.extraction_id') AND json_extract(r.data,'$.document_id')=d.id
 AND json_extract(r.data,'$.project_id')=json_extract(NEW.data,'$.project_id') AND d.project_id=json_extract(NEW.data,'$.project_id')
) BEGIN SELECT RAISE(ABORT,'Invalid reference ownership'); END;
CREATE TRIGGER event_drafts_owner_update BEFORE UPDATE ON event_drafts WHEN NOT EXISTS (
 SELECT 1 FROM extractions r JOIN documents d ON d.id=json_extract(NEW.data,'$.document_id')
 WHERE r.id=json_extract(NEW.data,'$.extraction_id') AND json_extract(r.data,'$.document_id')=d.id
 AND json_extract(r.data,'$.project_id')=json_extract(NEW.data,'$.project_id') AND d.project_id=json_extract(NEW.data,'$.project_id')
) BEGIN SELECT RAISE(ABORT,'Invalid reference ownership'); END;
