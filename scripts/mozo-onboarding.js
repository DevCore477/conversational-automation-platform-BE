#!/usr/bin/env node
// Runs the REAL Mozo App Store developer onboarding sequence (app-store-quickstart.md
// Steps 1-7) against Mozo's actual API — not the local mock. This is the only way to get
// real MOZO_CLIENT_ID / MOZO_CLIENT_SECRET; nothing about this can be faked or skipped.
//
// Requires a Mozo staff/developer JWT (STAFF_JWT) — only whoever has a real Mozo developer
// login can run this. If you'd rather not paste that JWT into a chat, run this yourself
// locally and share just the printed output (MOZO_CLIENT_ID/SECRET are what matter, not
// the JWT that produced them).
//
// Usage:
//   API_BASE_URL=https://<mozo-env> STAFF_JWT=<jwt> VENUE_ID=<venue-id> \
//     node scripts/mozo-onboarding.js
//
// Optional:
//   APP_ID=<existing app_id>   — skip developer/app creation, resume from scope config
//   APP_SLUG, APP_NAME, APP_CATEGORY, APP_TAGS (comma-separated)
//   DEVELOPER_EMAIL, DEVELOPER_NAME, DEVELOPER_COMPANY, DEVELOPER_WEBSITE
//   SCOPES (comma-separated scope:reason pairs are too fiddly for env — edit DEFAULT_SCOPES below)
//   SKIP_REVIEW=1              — stop after install, don't submit for review

const API_BASE_URL = requireEnv('API_BASE_URL');
const STAFF_JWT = requireEnv('STAFF_JWT');
const VENUE_ID = requireEnv('VENUE_ID');

const DEFAULT_SCOPES = [
  { scope: 'orders:read', reason: 'Read venue orders for the HexaAI voice agent' },
  { scope: 'orders:write', reason: 'Create/update orders from a phone booking' },
  { scope: 'menu:read', reason: 'Answer menu questions during a call' },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function call(method, path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STAFF_JWT}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = json?.message || json?.error?.message || json?.error || text || `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed (${response.status}): ${message}`);
  }

  return json;
}

async function main() {
  console.log(`Mozo onboarding against ${API_BASE_URL}\n`);

  let appId = process.env.APP_ID;

  if (!appId) {
    console.log('1. Creating developer profile...');
    try {
      await call('POST', '/v4/app-store/developer', {
        email: requireEnv('DEVELOPER_EMAIL'),
        name: requireEnv('DEVELOPER_NAME'),
        company_name: process.env.DEVELOPER_COMPANY,
        website_url: process.env.DEVELOPER_WEBSITE,
      });
      console.log('   done.\n');
    } catch (err) {
      console.log(`   (continuing — profile may already exist: ${err.message})\n`);
    }

    console.log('2. Creating app...');
    const appTags = process.env.APP_TAGS ? process.env.APP_TAGS.split(',').map(s => s.trim()) : undefined;
    const app = await call('POST', '/v4/app-store/app', {
      slug: process.env.APP_SLUG || 'hexaai',
      name: process.env.APP_NAME || 'HexaAI',
      category: process.env.APP_CATEGORY || 'operations',
      tags: appTags,
    });
    appId = app.app_id || app.id || app.data?.app_id || app.data?.id;
    if (!appId) {
      console.error('   Could not find app_id in the response:', JSON.stringify(app));
      process.exit(1);
    }
    console.log(`   app_id = ${appId}\n`);
  } else {
    console.log(`1-2. Skipping developer/app creation — using APP_ID=${appId}\n`);
  }

  console.log('3. Configuring scopes:', DEFAULT_SCOPES.map(s => s.scope).join(', '));
  await call('PUT', `/v4/app-store/app/${appId}/scope`, { scopes: DEFAULT_SCOPES });
  console.log('   done.\n');

  console.log('4. Rotating credentials (this is the step that mints MOZO_CLIENT_ID/SECRET)...');
  const credentials = await call('POST', `/v4/app-store/app/${appId}/credential/rotate`, undefined);
  const clientId = credentials.client_id || credentials.data?.client_id;
  const clientSecret = credentials.client_secret || credentials.data?.client_secret;
  if (!clientId || !clientSecret) {
    console.error('   Could not find client_id/client_secret in the response:', JSON.stringify(credentials));
    process.exit(1);
  }
  console.log('   done.\n');

  console.log(`5. Installing app ${appId} into venue ${VENUE_ID}...`);
  await call('POST', `/v4/app-store/venue/${VENUE_ID}/install`, { app_id: appId });
  console.log('   done.\n');

  if (process.env.SKIP_REVIEW !== '1') {
    console.log('6. Submitting for review...');
    await call('POST', `/v4/app-store/app/${appId}/review`, { submission_snapshot: {} });
    console.log('   done — a Mozo reviewer must approve this before /v4/app-store/auth/token');
    console.log('   will accept these credentials. Check status with:');
    console.log(`   GET ${API_BASE_URL}/v4/app-store/app/${appId} (Authorization: Bearer $STAFF_JWT)\n`);
  } else {
    console.log('6. Skipped (SKIP_REVIEW=1) — app stays in draft until you submit it yourself.\n');
  }

  console.log('=================================================================');
  console.log('Add these to .env:');
  console.log('=================================================================');
  console.log(`MOZO_CLIENT_ID=${clientId}`);
  console.log(`MOZO_CLIENT_SECRET=${clientSecret}`);
  console.log(`MOZO_API_URL=${API_BASE_URL}`);
  console.log(`MOZO_SINGLE_TENANT_VENUE_ID=${VENUE_ID}`);
  console.log('=================================================================');
  console.log('client_secret is shown once, right here — Mozo never returns it again.');
}

main().catch(err => {
  console.error(`\nOnboarding failed: ${err.message}`);
  process.exit(1);
});
