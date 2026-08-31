-- Multimodal media understanding: one row per media/structured-content inbound message
-- (image/video/audio/document/sticker/location/contact), holding download + AI analysis + embedding.

CREATE TABLE IF NOT EXISTS whatsapp_message_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" UUID NOT NULL REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  "companyId" UUID REFERENCES companies(id) ON DELETE SET NULL,
  "mediaType" VARCHAR(16) NOT NULL,
  "metaMediaId" VARCHAR(128),
  "mimeType" VARCHAR(128),
  sha256 VARCHAR(128),
  "fileSizeBytes" BIGINT,
  "s3Key" TEXT,
  "s3Url" TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  "errorMessage" TEXT,
  "processedAt" TIMESTAMPTZ,
  "visionDescription" TEXT,
  "ocrText" TEXT,
  "detectedObjects" JSONB,
  entities JSONB,
  "sceneSummary" TEXT,
  transcript TEXT,
  "extractedText" TEXT,
  "structuredData" JSONB,
  "durationSeconds" INT,
  width INT,
  height INT,
  "pageCount" INT,
  embedding JSONB,
  "embeddingModel" VARCHAR(64),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_message_media_message
  ON whatsapp_message_media ("messageId");

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_media_conversation
  ON whatsapp_message_media ("conversationId", "createdAt");

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_media_status
  ON whatsapp_message_media (status);
