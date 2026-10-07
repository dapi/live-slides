CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_logins (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS has_pending_documents boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app_users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  personal_source boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  original bytea NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','error')),
  error text,
  chunk_count integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, owner_id) REFERENCES projects(id, owner_id) ON DELETE CASCADE,
  UNIQUE (project_id, sha256),
  UNIQUE (id, project_id, owner_id)
);
CREATE TABLE IF NOT EXISTS document_chunks (
  document_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  ordinal integer NOT NULL,
  text text NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model text NOT NULL,
  PRIMARY KEY (document_id, ordinal),
  FOREIGN KEY (document_id, project_id, owner_id) REFERENCES documents(id, project_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS documents_project ON documents(owner_id, project_id, status);
CREATE INDEX IF NOT EXISTS chunks_project ON document_chunks(owner_id, project_id);
-- Exact vector search within a project: filtering happens before ranking. No approximate
-- global index which might lose recall when the majority of its neighbours belong to others.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_projects ON projects;
CREATE POLICY own_projects ON projects USING (owner_id::text = current_setting('app.user_id', true))
  WITH CHECK (owner_id::text = current_setting('app.user_id', true)
    AND (NOT personal_source OR EXISTS (SELECT 1 FROM app_users WHERE id = owner_id AND subject = 'corp:owner')));
DROP POLICY IF EXISTS own_documents ON documents;
CREATE POLICY own_documents ON documents USING (owner_id::text = current_setting('app.user_id', true))
  WITH CHECK (owner_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS own_chunks ON document_chunks;
CREATE POLICY own_chunks ON document_chunks USING (owner_id::text = current_setting('app.user_id', true))
  WITH CHECK (owner_id::text = current_setting('app.user_id', true));
