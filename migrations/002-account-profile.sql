-- Credentials belong to Live Slides; the stable identity and project ownership stay intact.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS username text;
UPDATE app_users SET username = lower(substring(subject FROM 7))
  WHERE subject LIKE 'local:%' AND username IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_username ON app_users(username);
