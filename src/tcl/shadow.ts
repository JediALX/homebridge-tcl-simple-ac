import {
  GetThingShadowCommand,
  IoTDataPlaneClient,
  PublishCommand,
} from '@aws-sdk/client-iot-data-plane';

import { Logger, TclSession } from './auth';

/**
 * TCL reports the IoT endpoint in MQTT form (e.g. "wss://xxx-ats.iot.eu-central-1.amazonaws.com/mqtt");
 * the shadow REST/publish API needs the bare host as an https URL.
 */
export function normalizeIotEndpoint(endpoint: string): string {
  const host = endpoint
    .replace(/^[a-z+]+:\/\//i, '') // strip wss://, mqtts://, https://, ...
    .replace(/[/:].*$/, '');       // strip path and port
  return `https://${host}`;
}

/** Raw AWS IoT thing-shadow document for a TCL device. */
export interface ShadowDocument {
  state?: {
    reported?: Record<string, unknown>;
    desired?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  metadata?: unknown;
  version?: number;
  timestamp?: number;
}

export class ShadowClient {
  private client: IoTDataPlaneClient | null = null;

  constructor(
    private readonly session: TclSession,
    private readonly endpointOverride?: string,
    private readonly log?: Logger,
  ) {}

  private async getClient(): Promise<IoTDataPlaneClient> {
    if (this.client) {
      return this.client;
    }
    const cloudUrls = await this.session.getCloudUrls();
    const tokens = await this.session.getTokens();
    const endpoint = this.endpointOverride ?? tokens.mqttEndpoint;

    this.client = new IoTDataPlaneClient({
      region: cloudUrls.cloudRegion,
      ...(endpoint ? { endpoint: normalizeIotEndpoint(endpoint) } : {}),
      credentials: async () => {
        const creds = await this.session.getAwsCredentials();
        return {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretKey,
          sessionToken: creds.sessionToken,
          expiration: new Date(creds.expiration * 1000),
        };
      },
    });
    return this.client;
  }

  /** Force the client to be rebuilt with fresh endpoints/credentials on next use. */
  invalidate(): void {
    this.client?.destroy();
    this.client = null;
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.log?.debug('%s failed (%s); rebuilding IoT client and retrying once', operation, (e as Error).message);
      this.invalidate();
      return fn();
    }
  }

  async getShadow(deviceId: string): Promise<ShadowDocument> {
    return this.withRetry('getShadow', async () => {
      const client = await this.getClient();
      const response = await client.send(new GetThingShadowCommand({ thingName: deviceId }));
      const payload = new TextDecoder().decode(response.payload);
      return JSON.parse(payload) as ShadowDocument;
    });
  }

  /** Publish a desired-state update, exactly as the TCL Home app does. */
  async setDesiredState(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify({
      state: { desired },
      clientToken: `mobile_${Math.floor(Date.now() / 1000)}`,
    });
    await this.withRetry('setDesiredState', async () => {
      const client = await this.getClient();
      await client.send(new PublishCommand({
        topic: `$aws/things/${deviceId}/shadow/update`,
        qos: 1,
        payload: Buffer.from(payload, 'utf8'),
      }));
    });
  }
}
