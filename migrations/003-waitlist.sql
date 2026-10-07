-- Early-access requests from the public page, with the state of their delivery to the CRM.
-- Not tenant data: there is no row security here, and the list is served to the owner only.
CREATE TABLE IF NOT EXISTS waitlist_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  email text NOT NULL,
  note text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  crm_status text NOT NULL DEFAULT 'pending' CHECK (crm_status IN ('pending', 'delivered', 'duplicate', 'failed', 'off')),
  crm_attempts integer NOT NULL DEFAULT 0,
  crm_delivered_at timestamptz,
  crm_error text
);
CREATE INDEX IF NOT EXISTS waitlist_requests_pending ON waitlist_requests(created_at) WHERE crm_status IN ('pending', 'failed');
