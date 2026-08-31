-- Website Blogs module: editorial blog posts for the public marketing website,
-- authored by Super Admins. Fully separate from the `blogs` table (LinkedIn integration's
-- auto-generated post feed, see create-linkedin-and-blogs-tables.sql) — no shared table,
-- no shared FKs, no shared code.

CREATE TABLE IF NOT EXISTS website_blogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(280) NOT NULL,
  "shortDescription" VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  "featuredImage" VARCHAR(500),
  images JSONB NOT NULL DEFAULT '[]',
  "authorName" VARCHAR(150) NOT NULL,
  category VARCHAR(100),
  tags JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
  "publishedAt" TIMESTAMPTZ,
  "metaTitle" VARCHAR(255),
  "metaDescription" VARCHAR(500),
  "metaKeywords" VARCHAR(500),
  "canonicalUrl" VARCHAR(500),
  "createdByUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "deletedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_website_blogs_slug" ON website_blogs (slug);
CREATE INDEX IF NOT EXISTS "IDX_website_blogs_status" ON website_blogs (status);
CREATE INDEX IF NOT EXISTS "IDX_website_blogs_publishedAt" ON website_blogs ("publishedAt");
CREATE INDEX IF NOT EXISTS "IDX_website_blogs_category" ON website_blogs (category);

-- Public listing filters to status = 'published' AND deletedAt IS NULL on every query;
-- this composite index serves that lookup directly (newest published first).
CREATE INDEX IF NOT EXISTS "IDX_website_blogs_published_feed"
  ON website_blogs (status, "publishedAt" DESC)
  WHERE "deletedAt" IS NULL;
