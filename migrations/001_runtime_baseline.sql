CREATE TABLE IF NOT EXISTS runtime_health (
  service text PRIMARY KEY,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO runtime_health(service, status)
VALUES ('aether-api', 'ready')
ON CONFLICT (service) DO NOTHING;
