-- Project RLS also protects the draft, its prompt and its durable job state.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_prompt text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_slide jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_status text NOT NULL DEFAULT 'idle'
  CHECK (opening_status IN ('idle', 'queued', 'working', 'ready', 'error'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_revision integer NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_due timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_lease_until timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_upload_until timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opening_error text;

-- Runs as the invoking tenant, never SECURITY DEFINER. New/finished/retried documents
-- invalidate an in-flight draft; the worker may only commit the revision it claimed.
CREATE OR REPLACE FUNCTION queue_opening_slide() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects SET opening_status = 'queued', opening_revision = opening_revision + 1,
    opening_due = now() + interval '2 seconds', opening_error = NULL
    WHERE id = NEW.project_id AND owner_id = NEW.owner_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS documents_queue_opening ON documents;
CREATE TRIGGER documents_queue_opening AFTER INSERT OR UPDATE OF status ON documents
  FOR EACH ROW EXECUTE FUNCTION queue_opening_slide();
