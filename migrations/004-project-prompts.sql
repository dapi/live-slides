-- A presentation may bring its own prompts; empty text means the shipped one from PROMPTS_DIR.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS director_prompt text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS talk_brief text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS speech_terms text NOT NULL DEFAULT '';
