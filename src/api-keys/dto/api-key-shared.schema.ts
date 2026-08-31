import { z } from 'zod';

const PermissionSchema = z.object({
  create: z.boolean().optional(),
  read: z.boolean().optional(),
  update: z.boolean().optional(),
  delete: z.boolean().optional(),
});

const CompanyPermissionSchema = z.object({
  create: z.boolean().optional(),
  read: z.boolean().optional(),
  update: z.boolean().optional(),
});

const PlatformPermissionSchema = z.object({
  read: z.boolean().optional(),
  update: z.boolean().optional(),
});

const PermissionsObjectSchema = z.object({
  calls: PermissionSchema.optional(),
  scripts: PermissionSchema.optional(),
  flows: PermissionSchema.optional(),
  agents: PermissionSchema.optional(),
  analytics: z.object({ read: z.boolean().optional() }).optional(),
  webhooks: PermissionSchema.optional(),
  companies: CompanyPermissionSchema.optional(),
  platform: PlatformPermissionSchema.optional(),
  apiKeys: PermissionSchema.optional(),
});

export type PermissionsObject = z.infer<typeof PermissionsObjectSchema>;

/** Accepts array (e.g. `calls.read`) or object format from clients. */
export const FlexiblePermissions = z
  .union([z.array(z.string()), PermissionsObjectSchema])
  .optional()
  .transform((input): PermissionsObject | undefined => {
    if (!input) return undefined;

    if (!Array.isArray(input)) {
      return input;
    }

    if (input.includes('all')) {
      return {
        calls: { create: true, read: true, update: true, delete: true },
        scripts: { create: true, read: true, update: true, delete: true },
        flows: { create: true, read: true, update: true, delete: true },
        agents: { create: true, read: true, update: true, delete: true },
        analytics: { read: true },
        webhooks: { create: true, read: true, update: true, delete: true },
        companies: { create: true, read: true, update: true },
        platform: { read: true, update: true },
        apiKeys: { create: true, read: true, update: true, delete: true },
      };
    }

    const result: PermissionsObject = {};

    for (const perm of input) {
      const parts = perm.split('.');
      if (parts.length !== 2) continue;

      const [resourceStr, actionStr] = parts;
      if (!resourceStr || !actionStr) continue;

      const resource = resourceStr as keyof PermissionsObject;
      if (!(resource in PermissionsObjectSchema.shape)) {
        continue;
      }
      const action = actionStr as 'create' | 'read' | 'update' | 'delete';

      if (resource === 'analytics' && action !== 'read') {
        continue;
      }
      if (resource === 'platform' && action !== 'read' && action !== 'update') {
        continue;
      }
      if (
        resource === 'companies' &&
        action !== 'create' &&
        action !== 'read' &&
        action !== 'update'
      ) {
        continue;
      }
      if (!result[resource]) {
        (result as Record<string, Record<string, boolean>>)[resource] = {};
      }
      (result as Record<string, Record<string, boolean>>)[resource][action] = true;
    }

    return result;
  });

/** Normalizes partial ISO strings before `z.iso.datetime()` validation. */
export const FlexibleDateTime = z.preprocess(val => {
  if (typeof val !== 'string') return val;
  if (val.length === 16) return `${val}:00Z`;
  if (val.length === 19 && !val.endsWith('Z')) return `${val}Z`;
  return val;
}, z.iso.datetime().optional());

export const RestrictionsSchema = z
  .object({
    ipWhitelist: z.array(z.string()).optional(),
    rateLimit: z.number().optional(),
    allowedOrigins: z.array(z.string()).optional(),
  })
  .optional();
