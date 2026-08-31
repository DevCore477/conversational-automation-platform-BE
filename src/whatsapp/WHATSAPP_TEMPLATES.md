# WhatsApp message templates in Hexa AI

## How it works

Meta owns template **creation and approval**. Hexa AI stores a **per-company copy** in `whatsapp_templates` so campaigns and sends can reference templates by id safely.

```
Meta Business Manager  →  approve template  →  sync/register in Hexa  →  use in campaigns
```

| Layer | Responsibility |
|--------|----------------|
| **Meta** | Create template, submit for review, approve/reject |
| **Hexa DB** (`whatsapp_templates`) | Cache name, language, status, components per `companyId` |
| **Campaigns** | Use `templateId` (UUID from Hexa DB), send via `metaTemplateName` |

You can **sync from Meta**, **register** an approved template manually, or **copy from Meta’s template library** into your WABA (then wait for approval).

## Prerequisites

1. Run migrations: `multi-tenant-whatsapp.sql`, `add-whatsapp-template-meta-id.sql`, `add-whatsapp-template-library.sql`
2. Company WhatsApp config with `accessToken` and `phoneNumberId`
3. **`wabaId` must be the WhatsApp Business Account id** — not the phone number id. If unsure, leave `wabaId` empty; sync resolves it from `phoneNumberId` automatically.
3. Templates created and **APPROVED** in [Meta Business Manager](https://business.facebook.com/) → WhatsApp Manager → Message templates

## Recommended flow (sync)

1. **Super Admin** — configure company WhatsApp:
   `POST /admin/companies/{companyId}/whatsapp/config`

2. **Company user or Super Admin** — sync from Meta:
   ```http
   POST /whatsapp/message-templates/sync
   Authorization: Bearer <jwt>
   ```
   Or Super Admin:
   ```http
   POST /admin/companies/{companyId}/whatsapp/message-templates/sync
   ```

3. **List templates** (pick `id` for campaigns):
   ```http
   GET /whatsapp/message-templates?approvedOnly=true
   ```

4. **Create campaign** with `templateId` from step 3.

## Manual registration (no sync)

If sync is unavailable, register after Meta approval:

```http
POST /whatsapp/message-templates
{
  "name": "Order Update",
  "metaTemplateName": "order_update",
  "language": "en",
  "status": "approved",
  "category": "utility",
  "bodyPreview": "Hi {{1}}, your order {{2}} is ready."
}
```

`metaTemplateName` and `language` must **exactly** match Meta or sends will fail with error 132001.

## Meta template library

Browse Meta’s pre-built library (read-only until copied to your WABA):

```http
GET /whatsapp/message-templates/library?search=shipping&language=en_US&category=UTILITY&limit=25
```

Create a copy in your company WABA:

```http
POST /whatsapp/message-templates/from-library
{
  "libraryTemplateName": "order_shipped",
  "name": "order_shipped_acme",
  "language": "en_US",
  "category": "UTILITY",
  "bodyInputs": { "1": "Acme" },
  "buttonInputs": []
}
```

Then **sync** or wait for Meta approval webhooks. Library templates cannot be sent until status is `approved`.

Super Admin equivalents under `/admin/companies/{companyId}/whatsapp/message-templates/...`.

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/whatsapp/message-templates/library` | Browse Meta template library |
| POST | `/whatsapp/message-templates/from-library` | Copy library template to company WABA |
| GET | `/whatsapp/message-templates` | List company templates (paginated) |
| GET | `/whatsapp/message-templates/:id` | Get one |
| POST | `/whatsapp/message-templates` | Register template in DB |
| POST | `/whatsapp/message-templates/sync` | Pull all from Meta WABA |
| PATCH | `/whatsapp/message-templates/:id` | Update display name / status |
| DELETE | `/whatsapp/message-templates/:id` | Remove from Hexa (not from Meta) |
| POST | `/whatsapp/templates` | **Send** one template message (existing) |

## Database table

`whatsapp_templates`: `companyId`, `name`, `metaTemplateName`, `language`, `status`, `components`, `metaTemplateId`, `bodyPreview`, `source` (`custom` \| `meta_library` \| `synced`), `libraryTemplateName`, `qualityStatus`, `rejectionReason`, `isActive`, `lastSyncedAt`

`whatsapp_campaigns.templateVariableMapping` — default placeholder values per campaign slot (e.g. `"1": "{{name}}"`)

Unique: `(companyId, metaTemplateName, language)`

## Status values

- `approved` — usable in campaigns
- `pending` — not usable until Meta approves
- `rejected`, `paused`, `disabled` — not usable

Campaign service only allows `status = approved`.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `(#100) nonexisting field (message_templates)` | `wabaId` in company config is **not** a WABA id (often it is the phone number id). Clear `wabaId` in DB/config and call sync again — we resolve the real WABA from `phoneNumberId`. Or set the correct WABA from Meta Business Suite → WhatsApp accounts. |
| Permissions error (200) | Token needs `whatsapp_business_management` (and messaging) scopes |
| Empty template list | No templates created in Meta yet, or wrong WABA |
