-- Ensure conversation unread counter exists (camelCase column used by TypeORM / Nest entities)
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS "unreadCount" INT NOT NULL DEFAULT 0;

-- Backfill from inbound messages not yet marked read
UPDATE whatsapp_conversations c
SET "unreadCount" = sub.cnt
FROM (
  SELECT m."conversationId", COUNT(*)::int AS cnt
  FROM whatsapp_messages m
  WHERE m.direction = 'inbound'
    AND m.status IN ('received', 'pending', 'queued')
  GROUP BY m."conversationId"
) sub
WHERE c.id = sub."conversationId";
