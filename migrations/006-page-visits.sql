-- Visits to the public page: one row per visitor per day, the visitor being a hash that cannot be
-- reversed (a secret salt of the day, the address and the browser). Not tenant data.
CREATE TABLE IF NOT EXISTS visit_days (
  day date PRIMARY KEY,
  salt text NOT NULL
);
CREATE TABLE IF NOT EXISTS page_visits (
  day date NOT NULL REFERENCES visit_days(day),
  visitor text NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  referrer text NOT NULL DEFAULT '',
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, visitor)
);
