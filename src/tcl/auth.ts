import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * TCL Home cloud session.
 *
 * Auth chain (mirrors the official Android app, as documented by the
 * MIT-licensed ha-tcl-home-unofficial-integration project):
 *   1. POST <loginUrl>                      -> sso token + refresh token
 *   2. POST <cloudUrlsEndpoint>             -> regional cloud/device URLs (account-routed)
 *   3. POST <cloudUrl>/v3/auth/refresh_tokens -> saas token + Cognito token
 *   4. POST cognito-identity.<region>.amazonaws.com -> temporary AWS credentials
 * Every stage is cached (and persisted to disk) until its token expires.
 */

export interface TclSessionOptions {
  username: string;
  password: string;
  loginUrl: string;
  cloudUrlsEndpoint: string;
  appId: string;
  /** Directory where the session cache file is stored. */
  storageDir: string;
  log?: Logger;
}

export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

export interface AuthData {
  token: string;
  refreshToken: string;
  /** Account user id returned by the auth endpoint (used as ssoId/userId downstream). */
  username: string;
  countryAbbr?: string;
  nickname?: string;
}

export interface CloudUrls {
  ssoRegion?: string;
  cloudRegion: string;
  cloudUrl: string;
  deviceUrl: string;
  cloudUrlEmq?: string;
}

export interface Tokens {
  saasToken: string;
  cognitoToken: string;
  cognitoId?: string;
  mqttEndpoint?: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  /** Epoch seconds. */
  expiration: number;
  identityId?: string;
}

interface SessionCache {
  auth?: AuthData;
  cloudUrls?: CloudUrls;
  tokens?: Tokens;
  awsCredentials?: AwsCredentials;
}

const COMMON_HEADERS = {
  'user-agent': 'Android',
  'content-type': 'application/json; charset=UTF-8',
};

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function jwtClaimExpired(token: string, claim: string, skewSeconds = 60): boolean {
  const value = Number(decodeJwtPayload(token)[claim] ?? 0);
  return value < Date.now() / 1000 + skewSeconds;
}

export class TclAuthError extends Error {}

export class TclSession {
  private cache: SessionCache = {};
  private loaded = false;
  private readonly cacheFile: string;
  private readonly log?: Logger;

  constructor(private readonly options: TclSessionOptions) {
    this.cacheFile = path.join(options.storageDir, 'tcl-session.json');
    this.log = options.log;
  }

  /** Drop all cached tokens (e.g. after a hard auth failure). */
  async reset(): Promise<void> {
    this.cache = {};
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.cacheFile, 'utf8');
      this.cache = JSON.parse(raw) as SessionCache;
      this.log?.debug('Loaded cached TCL session from %s', this.cacheFile);
    } catch {
      this.cache = {};
    }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.writeFile(this.cacheFile, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    } catch (e) {
      this.log?.warn('Could not persist TCL session cache: %s', (e as Error).message);
    }
  }

  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new TclAuthError(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  async getAuthData(): Promise<AuthData> {
    await this.load();
    const cached = this.cache.auth;
    if (cached && !jwtClaimExpired(cached.token, 'exp') && !jwtClaimExpired(cached.refreshToken, 'exp')) {
      return cached;
    }
    return this.login();
  }

  private async login(): Promise<AuthData> {
    this.log?.info('Logging in to TCL Home account');
    const payload = {
      equipment: 2,
      password: md5Hex(this.options.password),
      osType: 1,
      username: this.options.username,
      clientVersion: '4.8.1',
      osVersion: '6.0',
      deviceModel: 'AndroidAndroid SDK built for x86',
      captchaRule: 2,
      channel: 'app',
    };
    const headers = {
      ...COMMON_HEADERS,
      'th_platform': 'android',
      'th_version': '4.8.1',
      'th_appbulid': '830',
    };
    const data = await this.post(this.options.loginUrl, payload, headers);
    if (data.status !== 1) {
      throw new TclAuthError(`TCL login failed (status=${data.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    const user = (data.user ?? {}) as Record<string, unknown>;
    const auth: AuthData = {
      token: String(data.token),
      refreshToken: String(data.refresh_token ?? data.refreshtoken),
      username: String(user.username ?? this.options.username),
      countryAbbr: (user.country_abbr ?? user.countryAbbr) as string | undefined,
      nickname: user.nickname as string | undefined,
    };
    // Downstream tokens are bound to this login: invalidate them.
    this.cache = { auth };
    await this.persist();
    return auth;
  }

  async getCloudUrls(): Promise<CloudUrls> {
    await this.load();
    if (this.cache.cloudUrls) {
      return this.cache.cloudUrls;
    }
    const auth = await this.getAuthData();
    this.log?.info('Discovering regional TCL cloud endpoints');
    const data = await this.post(
      this.options.cloudUrlsEndpoint,
      { ssoId: auth.username, ssoToken: auth.token },
      COMMON_HEADERS,
    );
    const d = (data.data ?? {}) as Record<string, unknown>;
    if (!d.cloud_url || !d.device_url || !d.cloud_region) {
      throw new TclAuthError(`Unexpected cloud_url_get response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const cloudUrls: CloudUrls = {
      ssoRegion: d.sso_region as string | undefined,
      cloudRegion: String(d.cloud_region),
      cloudUrl: String(d.cloud_url),
      deviceUrl: String(d.device_url),
      cloudUrlEmq: d.cloud_url_emq as string | undefined,
    };
    this.cache.cloudUrls = cloudUrls;
    await this.persist();
    return cloudUrls;
  }

  async getTokens(): Promise<Tokens> {
    await this.load();
    const cached = this.cache.tokens;
    if (
      cached &&
      !jwtClaimExpired(cached.saasToken, 'expiredDate') &&
      !jwtClaimExpired(cached.cognitoToken, 'exp')
    ) {
      return cached;
    }
    const auth = await this.getAuthData();
    const cloudUrls = await this.getCloudUrls();
    this.log?.debug('Refreshing TCL saas/Cognito tokens');
    const data = await this.post(
      `${cloudUrls.cloudUrl}/v3/auth/refresh_tokens`,
      { userId: auth.username, ssoToken: auth.token, appId: this.options.appId },
      COMMON_HEADERS,
    );
    const d = (data.data ?? {}) as Record<string, unknown>;
    const saasToken = (d.saas_token ?? d.saasToken) as string | undefined;
    const cognitoToken = (d.cognito_token ?? d.cognitoToken) as string | undefined;
    if (!saasToken || !cognitoToken) {
      throw new TclAuthError(`Unexpected refresh_tokens response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const tokens: Tokens = {
      saasToken,
      cognitoToken,
      cognitoId: (d.cognito_id ?? d.cognitoId) as string | undefined,
      mqttEndpoint: (d.mqtt_endpoint ?? d.mqttEndpoint) as string | undefined,
    };
    this.cache.tokens = tokens;
    await this.persist();
    return tokens;
  }

  async getAwsCredentials(): Promise<AwsCredentials> {
    await this.load();
    const cached = this.cache.awsCredentials;
    if (cached && cached.expiration > Date.now() / 1000 + 60) {
      return cached;
    }
    const tokens = await this.getTokens();
    const cloudUrls = await this.getCloudUrls();
    const identityId = String(decodeJwtPayload(tokens.cognitoToken).sub ?? '');
    this.log?.debug('Fetching temporary AWS credentials from Cognito');
    const data = await this.post(
      `https://cognito-identity.${cloudUrls.cloudRegion}.amazonaws.com/`,
      {
        IdentityId: identityId,
        Logins: { 'cognito-identity.amazonaws.com': tokens.cognitoToken },
      },
      {
        'User-agent': 'aws-sdk-android/2.22.6 Linux/6.1.23-android14 Dalvik/2.1.0/0 en_US',
        'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
        'content-type': 'application/x-amz-json-1.1',
      },
    );
    const creds = (data.Credentials ?? {}) as Record<string, unknown>;
    if (!creds.AccessKeyId) {
      throw new TclAuthError(`Unexpected Cognito response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const awsCredentials: AwsCredentials = {
      accessKeyId: String(creds.AccessKeyId),
      secretKey: String(creds.SecretKey),
      sessionToken: String(creds.SessionToken),
      expiration: Number(creds.Expiration),
      identityId: data.IdentityId as string | undefined,
    };
    this.cache.awsCredentials = awsCredentials;
    await this.persist();
    return awsCredentials;
  }

  /** Signed headers used by the TCL device REST API (get_things etc.). */
  async getApiHeaders(): Promise<Record<string, string>> {
    const tokens = await this.getTokens();
    const timestamp = String(Date.now());
    const nonce = Array.from({ length: 16 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
    return {
      ...COMMON_HEADERS,
      'platform': 'android',
      'appversion': '5.4.1',
      'thomeversion': '4.8.1',
      'accesstoken': tokens.saasToken,
      'accept-language': 'en',
      'timestamp': timestamp,
      'nonce': nonce,
      'sign': md5Hex(timestamp + nonce + tokens.saasToken),
      'accept-encoding': 'gzip, deflate, br',
    };
  }
}
