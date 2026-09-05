ALTER TABLE media_file ADD COLUMN review_reason TEXT;
ALTER TABLE media_file ADD COLUMN review_path TEXT;
CREATE INDEX media_file_review_path ON media_file(library_id, review_path)
  WHERE review_reason IS NOT NULL;
CREATE INDEX media_file_review_current_path ON media_file(library_id, path)
  WHERE review_reason IS NOT NULL;
