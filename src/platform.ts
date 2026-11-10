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
import { parseCompensationConfig, ParsedCompensation, SENSOR_POLL_PULSE_MS } from './compensation/config';
import { HomeKitTemperatureReceiver, RoomSource } from './compensation/receiver';
import { PushMonitor, SensorPollTrigger } from './compensation/sensorPoll';
import { CompensatedThermostat, CompensationLog, CompensationState } from './compensation/setpointCompensation';
import { CompensatingPolicy, ReleasingPolicy } from './compensation/targetPolicy';
import { TclDehumidifierAccessory } from './dehumidifier';
import { SensorPollSwitch } from './sensorPollSwitch';
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
  compensation?: unknown;
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
  private compensation: ParsedCompensation = { status: 'off' };
  private receiver?: HomeKitTemperatureReceiver;
  private sensorSwitch?: SensorPollSwitch;
  private sensorTrigger?: SensorPollTrigger;
  private pushMonitorTimer?: NodeJS.Timeout;

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

    this.compensation = parseCompensationConfig(
      this.config.compensation,
      { minSetpoint: this.minTemp, maxSetpoint: this.maxTemp },
      this.log,
    );
    if (this.compensation.status === 'on') {
      const { port, bindHost, token, rooms, logReadings } = this.compensation;
      this.receiver = new HomeKitTemperatureReceiver(
        { port, bindHost, token, rooms: [...new Set(rooms.values())], logEveryPush: logReadings },
        this.compensationLog(),
      );
    }

    this.api.on('didFinishLaunching', () => {
      if (this.receiver) {
        this.runSafely(this.receiver.start(), 'temperature receiver start');
      }
      this.runSafely(this.discoverDevices(), 'device discovery');
    });
    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      this.sensorTrigger?.stop();
      this.sensorSwitch?.stop();
      clearInterval(this.pushMonitorTimer);
      this.runSafely(this.receiver?.stop() ?? Promise.resolve(), 'temperature receiver stop');
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
      this.applyCompensation(thing, accessory, handler);
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

    // Kept while compensation is configured, even if invalid, because HomeKit
    // drops automations whose accessory disappears. When compensation is off
    // it is not in seenUuids, so the stale clean-up below removes it.
    if (this.compensation.status !== 'off') {
      const sensorUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:sensor-poll`);
      seenUuids.add(sensorUuid);
      let sensorAccessory = this.cachedAccessories.find((a) => a.UUID === sensorUuid);
      if (!sensorAccessory) {
        sensorAccessory = new this.api.platformAccessory('Sensor poll', sensorUuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [sensorAccessory]);
        this.log.info('Registered new accessory: Sensor poll');
      }
      this.startSensorPolling(sensorAccessory, acs);
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

  /**
   * Compensation for ACs mapped to a room; a one-off restore for ACs that
   * still carry state from when compensation was on; nothing otherwise.
   */
  private applyCompensation(thing: TclThing, accessory: PlatformAccessory, handler: TclAcAccessory): void {
    const stored = accessory.context.compensation as CompensationState | undefined;
    const persist = (state?: CompensationState) => {
      if (state) {
        accessory.context.compensation = state;
      } else {
        delete accessory.context.compensation;
      }
      this.api.updatePlatformAccessories([accessory]);
    };
    const log = this.compensationLog(thing.nickName);
    const roomKey = this.compensation.status === 'on' ? this.compensation.rooms.get(thing.deviceId) : undefined;

    if (this.compensation.status === 'on' && roomKey && this.receiver) {
      const thermostat = new CompensatedThermostat({
        device: handler.commandPort(),
        source: new RoomSource(this.receiver, roomKey),
        settings: this.compensation.settings,
        state: stored ?? {},
        persist,
        log,
        onDisplayChange: () => handler.pushState(),
      });
      handler.setPolicy(new CompensatingPolicy(
        thermostat,
        (work) => this.runSafely(work, `compensation for ${thing.nickName}`),
      ));
      this.log.info('[%s] external-sensor compensation on (room "%s")', thing.nickName, roomKey);
    } else if (stored) {
      handler.setPolicy(new ReleasingPolicy(stored, handler.commandPort(), log, () => persist(undefined)));
      this.log.info('[%s] compensation is off for this AC; its plain target will be restored', thing.nickName);
    }
  }

  private startSensorPolling(sensorAccessory: PlatformAccessory, acs: TclThing[]): void {
    this.sensorSwitch = new SensorPollSwitch(this, sensorAccessory);
    if (this.compensation.status !== 'on' || !this.receiver) {
      return;
    }
    const { rooms, sensorPollIntervalMs } = this.compensation;
    for (const deviceId of rooms.keys()) {
      if (!acs.some((ac) => ac.deviceId === deviceId)) {
        this.log.warn('Compensation: device %s in "rooms" is not one of the exposed ACs', deviceId);
      }
    }
    this.sensorTrigger = new SensorPollTrigger(this.sensorSwitch, sensorPollIntervalMs, SENSOR_POLL_PULSE_MS);
    this.sensorTrigger.start();
    const monitor = new PushMonitor(
      this.receiver, [...new Set(rooms.values())], sensorPollIntervalMs, this.compensationLog(),
    );
    this.pushMonitorTimer = setInterval(() => monitor.check(), sensorPollIntervalMs);
  }

  private compensationLog(prefix?: string): CompensationLog {
    const p = prefix ? `[${prefix}] ` : '';
    return {
      info: (message) => this.log.info('%s', p + message),
      warn: (message) => this.log.warn('%s', p + message),
      debug: (message) => this.log.debug('%s', p + message),
    };
  }

  private async pollAll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.poll();
    }
  }
}
