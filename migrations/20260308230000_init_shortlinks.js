/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS short_links (
      id TEXT PRIMARY KEY,
      payload JSONB,
      payload_kind TEXT NOT NULL DEFAULT 'state',
      state JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    )
  `);

  pgm.sql(`ALTER TABLE short_links ADD COLUMN IF NOT EXISTS payload JSONB`);
  pgm.sql(`ALTER TABLE short_links ADD COLUMN IF NOT EXISTS payload_kind TEXT NOT NULL DEFAULT 'state'`);
  pgm.sql(`ALTER TABLE short_links ADD COLUMN IF NOT EXISTS state JSONB`);
  pgm.sql(`UPDATE short_links SET payload = state WHERE payload IS NULL AND state IS NOT NULL`);
  pgm.sql(`UPDATE short_links SET payload_kind = 'state' WHERE payload_kind IS NULL OR payload_kind = ''`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_short_links_expires_at ON short_links (expires_at)`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS short_links`);
};
