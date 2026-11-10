/**
 * Test doubles for exercising accessories and the platform without Homebridge
 * or the TCL cloud. Real HAP Service/Characteristic classes are used so that
 * characteristic values, props and handlers behave exactly as in production.
 * Excluded from the build (see tsconfig.json).
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';

import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';

import type { TclAcAccessory } from '../accessory';
import type { TclSimpleAcPlatform } from '../platform';
import type { TclThing } from '../tcl/api';

export { Characteristic, Service, uuid };

type ServiceType = { UUID: string; new (displayName?: string, subtype?: string): Service };

export class FakeAccessory {
  readonly services: Service[] = [new Service.AccessoryInformation()];
  context: Record<string, unknown> = {};

  constructor(public displayName: string, public readonly UUID: string) {}

  getService(type: ServiceType): Service | undefined {
    return this.services.find((s) => s.UUID === type.UUID);
  }

  addService(type: ServiceType, name?: string): Service {
    const service = new type(name ?? this.displayName);
    this.services.push(service);
    return service;
  }
}

export class FakeShadow {
  reported: Record<string, unknown>;
  readonly published: Record<string, unknown>[] = [];
  /** Every publish with the device it went to. */
  readonly writes: { deviceId: string; desired: Record<string, unknown> }[] = [];
  failPublishes = 0;
  getShadowCalls = 0;

  constructor(reported: Record<string, unknown>) {
    this.reported = { ...reported };
  }

  async getShadow(): Promise<{ state: { reported: Record<string, unknown> } }> {
    this.getShadowCalls++;
    return { state: { reported: { ...this.reported } } };
  }

  async setDesiredState(deviceId: string, desired: Record<string, unknown>): Promise<void> {
    if (this.failPublishes > 0) {
      this.failPublishes--;
      throw new Error('simulated publish failure');
    }
    this.published.push({ ...desired });
    this.writes.push({ deviceId, desired: { ...desired } });
  }
}

export class FakeLog {
  readonly lines: { level: string; msg: string }[] = [];

  private add(level: string, msg: string, params: unknown[]): void {
    let i = 0;
    const text = String(msg).replace(/%[sdj]/g, () => {
      const p = params[i++];
      return typeof p === 'object' ? JSON.stringify(p) : String(p);
    });
    this.lines.push({ level, msg: text });
  }

  debug = (msg: string, ...p: unknown[]) => this.add('debug', msg, p);
  info = (msg: string, ...p: unknown[]) => this.add('info', msg, p);
  warn = (msg: string, ...p: unknown[]) => this.add('warn', msg, p);
  error = (msg: string, ...p: unknown[]) => this.add('error', msg, p);
  success = (msg: string, ...p: unknown[]) => this.add('info', msg, p);
  log = (level: string, msg: string, ...p: unknown[]) => this.add(level, msg, p);

  at(level: string): string[] {
    return this.lines.filter((l) => l.level === level).map((l) => l.msg);
  }
}

/** A BreezeIN 2.0 shaped `reported` document (field names as seen in the probe dump). */
export const BREEZEIN_REPORTED = {
  powerSwitch: 1,
  workMode: 4, // heat
  targetTemperature: 22,
  currentTemperature: 23.5,
  windSpeed7Gear: 0,
  windSpeedAutoSwitch: 1,
  verticalWind: 0,
  horizontalWind: 0,
  AIECOSwitch: 0,
  sleep: 0,
  eightAddHot: 0,
};

export const THING: TclThing = {
  deviceId: 'dev-living',
  nickName: 'Living AC',
  deviceName: 'Split AC',
  deviceType: '',
  firmwareVersion: '1.0',
  isOnline: true,
};

export interface FakePlatform {
  platform: TclSimpleAcPlatform;
  log: FakeLog;
  shadow: FakeShadow;
  backgroundErrors: unknown[];
  accessoryUpdates: number;
}

/** Minimal stand-in for TclSimpleAcPlatform, enough for TclAcAccessory. */
export function fakePlatform(reported: Record<string, unknown> = BREEZEIN_REPORTED): FakePlatform {
  const log = new FakeLog();
  const shadow = new FakeShadow(reported);
  const result: FakePlatform = {
    log,
    shadow,
    backgroundErrors: [],
    accessoryUpdates: 0,
    platform: undefined as unknown as TclSimpleAcPlatform,
  };
  result.platform = {
    Service,
    Characteristic,
    log,
    shadow,
    minTemp: 16,
    maxTemp: 31,
    dehumidifierEnabled: false,
    api: {
      hap: { HapStatusError, HAPStatus, uuid },
      updatePlatformAccessories: () => { result.accessoryUpdates++; },
    },
    runSafely: (work: Promise<unknown>) => {
      work.catch((e) => result.backgroundErrors.push(e));
    },
  } as unknown as TclSimpleAcPlatform;
  return result;
}

export function heaterCooler(accessory: FakeAccessory): Service {
  const service = accessory.getService(Service.HeaterCooler);
  if (!service) {
    throw new Error('no HeaterCooler service');
  }
  return service;
}

/** Let pending promise chains (fake cloud calls) settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Stand-in for Homebridge's API: records accessory (un)registrations and cache updates. */
export class FakeApi extends EventEmitter {
  readonly hap = { Service, Characteristic, uuid, HapStatusError, HAPStatus };
  readonly platformAccessory = FakeAccessory;
  readonly user = { storagePath: () => os.tmpdir() };
  readonly registered: FakeAccessory[] = [];
  readonly unregistered: FakeAccessory[] = [];
  updates = 0;

  registerPlatformAccessories(_plugin: string, _platform: string, accessories: FakeAccessory[]): void {
    this.registered.push(...accessories);
  }

  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: FakeAccessory[]): void {
    this.unregistered.push(...accessories);
  }

  updatePlatformAccessories(): void {
    this.updates++;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { TclAcAccessory };
