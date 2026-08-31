-- Migration: Create mozo_venue_links table for the Mozo App Store bridge (/mozo/*)
-- Maps a Mozo venue_id to the HexaAI company API key that should service it.

CREATE TABLE IF NOT EXISTS mozo_venue_links (
  venue_id VARCHAR(255) PRIMARY KEY,
  api_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
