/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("ALTER TABLE short_links ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb");
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE short_links DROP COLUMN IF EXISTS options');
};
