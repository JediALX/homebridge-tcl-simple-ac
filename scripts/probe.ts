/**
 * Standalone probe: logs in to TCL Home, lists devices, and dumps the raw
 * AWS IoT shadow of each AC. Use this to verify connectivity and to learn
 * the exact shadow properties of your model before/while using the plugin.
 *
 * Usage:
 *   TCL_USERNAME='you@example.com' TCL_PASSWORD='secret' npm run probe
 *
 * Optional env vars: TCL_LOGIN_URL, TCL_CLOUD_URLS_ENDPOINT, TCL_APP_ID
 */
import os from 'node:os';
import path from 'node:path';

import { getThings } from '../src/tcl/api';
import { TclSession } from '../src/tcl/auth';
import { ShadowClient } from '../src/tcl/shadow';
import { DEFAULT_APP_ID, DEFAULT_CLOUD_URLS_ENDPOINT, DEFAULT_LOGIN_URL } from '../src/settings';

const log = {
  debug: (...a: unknown[]) => console.error('[debug]', ...a),
  info: (...a: unknown[]) => console.error('[info]', ...a),
  warn: (...a: unknown[]) => console.error('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
};

async function main(): Promise<void> {
  const username = process.env.TCL_USERNAME;
  const password = process.env.TCL_PASSWORD;
  if (!username || !password) {
    console.error('Set TCL_USERNAME and TCL_PASSWORD environment variables first.');
    process.exit(1);
  }

  const session = new TclSession({
    username,
    password,
    loginUrl: process.env.TCL_LOGIN_URL || DEFAULT_LOGIN_URL,
    cloudUrlsEndpoint: process.env.TCL_CLOUD_URLS_ENDPOINT || DEFAULT_CLOUD_URLS_ENDPOINT,
    appId: process.env.TCL_APP_ID || DEFAULT_APP_ID,
    storageDir: path.join(os.tmpdir(), 'tcl-simple-ac-probe'),
    log,
  });

  const auth = await session.getAuthData();
  console.error(`[info] Logged in as ${auth.nickname ?? auth.username} (country: ${auth.countryAbbr ?? 'unknown'})`);

  const cloudUrls = await session.getCloudUrls();
  console.error(`[info] Region: ${cloudUrls.cloudRegion}, device URL: ${cloudUrls.deviceUrl}`);

  const things = await getThings(session);
  console.error(`[info] Found ${things.length} device(s)`);

  const shadowClient = new ShadowClient(session, process.env.TCL_IOT_ENDPOINT, log);
  const result = [];
  for (const thing of things) {
    let shadow: unknown;
    try {
      shadow = await shadowClient.getShadow(thing.deviceId);
    } catch (e) {
      shadow = { error: (e as Error).message };
    }
    result.push({ device: thing, shadow });
  }

  // The full dump goes to stdout so it can be redirected to a file.
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('[error]', e);
  process.exit(1);
});
