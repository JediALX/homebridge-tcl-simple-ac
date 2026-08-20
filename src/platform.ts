import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import path from 'node:path';

import { TclAcAccessory } from './accessory';
import { TclDehumidifierAccessory } from './dehumidifier';
import {
  DEFAULT_APP_ID,
  DEFAULT_CLOUD_URLS_ENDPOINT,
  DEFAULT_LOGIN_URL,
  DEFAULT_MAX_TEMP_C,
  DEFAULT_MIN_TEMP_C,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { getThings, isSplitAc, TclThing } from './tcl/api';
import { TclSession } from './tcl/auth';
import { ShadowClient } from './tcl/shadow';

export interface TclPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  pollInterval?: number;
  devices?: string[];
  enableDehumidifier?: boolean;
  minTemp?: number;
  maxTemp?: number;
  loginUrl?: string;
  cloudUrlsEndpoint?: string;
  appId?: string;
  iotEndpoint?: string;
}

export class TclSimpleAcPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly config: TclPlatformConfig;
  public session!: TclSession;
  public shadow!: ShadowClient;

  public readonly minTemp: number;
  public readonly maxTemp: number;
  public readonly pollIntervalMs: number;
  public readonly dehumidifierEnabled: boolean;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly handlers = new Map<string, TclAcAccessory>();
  private pollTimer?: NodeJS.Timeout;
  private discoveryBackoffMs = 60_000;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as TclPlatformConfig;

    this.minTemp = this.config.minTemp ?? DEFAULT_MIN_TEMP_C;
    this.maxTemp = this.config.maxTemp ?? DEFAULT_MAX_TEMP_C;
    this.dehumidifierEnabled = this.config.enableDehumidifier === true;
    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_SECONDS,
      this.config.pollInterval ?? DEFAULT_POLL_INTERVAL_SECONDS,
    ) * 1000;

    if (!this.config.username || !this.config.password) {
      this.log.error('Missing TCL Home username/password in config; plugin will not start.');
      return;
    }

    this.session = new TclSession({
      username: this.config.username,
      password: this.config.password,
      loginUrl: this.config.loginUrl || DEFAULT_LOGIN_URL,
      cloudUrlsEndpoint: this.config.cloudUrlsEndpoint || DEFAULT_CLOUD_URLS_ENDPOINT,
      appId: this.config.appId || DEFAULT_APP_ID,
      storageDir: path.join(api.user.storagePath(), 'tcl-simple-ac'),
      log: this.log,
    });
    this.shadow = new ShadowClient(this.session, this.config.iotEndpoint, this.log);

    this.api.on('didFinishLaunching', () => {
      this.runSafely(this.discoverDevices(), 'device discovery');
    });
    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  /**
   * Last line of defence for background work: an unhandled rejection here
   * would take the whole Homebridge process down with it.
   */
  runSafely(work: Promise<unknown>, what: string): void {
    work.catch((e) => this.log.error('Unexpected error during %s: %s', what, (e as Error).stack ?? e));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    let things: TclThing[];
    try {
      things = await getThings(this.session);
    } catch (e) {
      this.log.error('TCL device discovery failed: %s', (e as Error).message);
      this.log.info('Retrying discovery in %d s', this.discoveryBackoffMs / 1000);
      setTimeout(() => this.runSafely(this.discoverDevices(), 'device discovery'), this.discoveryBackoffMs);
      this.discoveryBackoffMs = Math.min(this.discoveryBackoffMs * 2, 600_000);
      return;
    }
    this.discoveryBackoffMs = 60_000;

    const allowlist = this.config.devices?.filter((id) => id.trim() !== '');
    const acs = things.filter((thing) =>
      allowlist?.length ? allowlist.includes(thing.deviceId) : isSplitAc(thing),
    );

    this.log.info(
      'TCL account has %d device(s); exposing %d AC(s): %s',
      things.length,
      acs.length,
      acs.map((ac) => `${ac.nickName} (${ac.deviceId}, ${ac.deviceType ?? 'unknown type'})`).join(', ') || 'none',
    );
    for (const skipped of things.filter((t) => !acs.includes(t))) {
      this.log.debug('Skipping device %s (%s, type=%s)', skipped.nickName, skipped.deviceId, skipped.deviceType);
    }

    const seenUuids = new Set<string>();
    for (const thing of acs) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${thing.deviceId}`);
      seenUuids.add(uuid);
      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(thing.nickName, uuid);
        accessory.context.deviceId = thing.deviceId;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Registered new accessory: %s', thing.nickName);
      }
      accessory.context.deviceId = thing.deviceId;
      const handler = new TclAcAccessory(this, accessory, thing);
      this.handlers.set(thing.deviceId, handler);

      if (this.dehumidifierEnabled) {
        const dhUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${thing.deviceId}:dehumidifier`);
        seenUuids.add(dhUuid);
        let dhAccessory = this.cachedAccessories.find((a) => a.UUID === dhUuid);
        if (!dhAccessory) {
          dhAccessory = new this.api.platformAccessory(`${thing.nickName} Dehumidifier`, dhUuid);
          dhAccessory.context.deviceId = thing.deviceId;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [dhAccessory]);
          this.log.info('Registered new accessory: %s Dehumidifier', thing.nickName);
        }
        dhAccessory.context.deviceId = thing.deviceId;
        handler.attachSatellite(new TclDehumidifierAccessory(this, dhAccessory, thing, handler));
      }
    }

    const stale = this.cachedAccessories.filter((a) => !seenUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info('Removing %d stale accessory(ies)', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    await this.pollAll();
    this.pollTimer = setInterval(
      () => this.runSafely(this.pollAll(), 'poll'),
      this.pollIntervalMs,
    );
  }

  private async pollAll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.poll();
    }
  }
}
