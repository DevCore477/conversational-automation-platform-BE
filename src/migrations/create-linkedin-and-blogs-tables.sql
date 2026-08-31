-- LinkedIn Company Page integration (Hexa AI's own page — single global connection)
-- + auto-generated public blog posts for the website

CREATE TABLE IF NOT EXISTS linkedin_organizations (
  id VARCHAR(32) PRIMARY KEY DEFAULT 'default',
  "organizationUrn" VARCHAR(255) NOT NULL,
  "organizationId" VARCHAR(64) NOT NULL,
  "organizationName" VARCHAR(255),
  "accessTokenEncrypted" TEXT NOT NULL,
  "refreshTokenEncrypted" TEXT,
  scope VARCHAR(500),
  "accessTokenExpiresAt" TIMESTAMPTZ NOT NULL,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  "connectedByUserId" UUID,
  "lastSyncedAt" TIMESTAMPTZ,
  "needsReconnect" BOOLEAN NOT NULL DEFAULT FALSE,
  "lastSyncError" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(280) NOT NULL,
  content TEXT NOT NULL,
  excerpt VARCHAR(500),
  "coverImageUrl" VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  "sourcePostUrn" VARCHAR(255),
  hashtags JSONB NOT NULL DEFAULT '[]',
  "publishedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_blogs_slug" ON blogs (slug);

-- Idempotency guard: a LinkedIn post can only ever produce one blog, even under concurrent sync runs.
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_blogs_sourcePostUrn"
  ON blogs ("sourcePostUrn") WHERE "sourcePostUrn" IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" VARCHAR(32) NOT NULL REFERENCES linkedin_organizations(id) ON DELETE CASCADE,
  "postUrn" VARCHAR(255) NOT NULL,
  commentary TEXT,
  hashtags JSONB NOT NULL DEFAULT '[]',
  "publishedAt" TIMESTAMPTZ,
  "postUrl" VARCHAR(500),
  "imageUrls" JSONB NOT NULL DEFAULT '[]',
  "videoUrls" JSONB NOT NULL DEFAULT '[]',
  engagement JSONB,
  "rawPayload" JSONB NOT NULL,
  "blogId" UUID REFERENCES blogs(id) ON DELETE SET NULL,
  "processedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe to re-run: adds the media/engagement columns to a linkedin_posts table created by an
-- earlier version of this migration.
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS "postUrl" VARCHAR(500);
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS "imageUrls" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS "videoUrls" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE linkedin_posts ADD COLUMN IF NOT EXISTS engagement JSONB;

-- Idempotency guard: de-dupes the same LinkedIn post being fetched by overlapping/concurrent syncs.
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_linkedin_posts_org_postUrn"
  ON linkedin_posts ("organizationId", "postUrn");
