import { TclAuthError, TclSession } from './auth';

export interface TclThing {
  deviceId: string;
  productKey?: string;
  nickName: string;
  deviceName?: string;
  category?: string;
  deviceType?: string;
  firmwareVersion?: string;
  isOnline: boolean;
  room?: string;
}

/** Normalize a deviceType like "Split AC-2" down to "Split AC". */
export function baseDeviceType(deviceType: string | undefined): string {
  if (!deviceType) {
    return '';
  }
  return deviceType.replace(/-\d+$/, '').trim();
}

export function isSplitAc(thing: TclThing): boolean {
  // Prefer deviceType, but some firmwares (e.g. BreezeIN 2.0) leave it empty
  // and report "Split AC" in deviceName instead.
  for (const candidate of [thing.deviceType, thing.deviceName]) {
    const type = baseDeviceType(candidate).toLowerCase();
    if (type === 'split ac' || type === 'split ac fresh air') {
      return true;
    }
    if (type !== '') {
      return false;
    }
  }
  // Last resort: anything in the AC category that didn't identify itself.
  return (thing.category ?? '').toUpperCase() === 'AC';
}

function firstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) {
      return String(data[key]);
    }
  }
  return undefined;
}

/** List all devices registered to the TCL Home account. */
export async function getThings(session: TclSession): Promise<TclThing[]> {
  const cloudUrls = await session.getCloudUrls();
  const headers = await session.getApiHeaders();
  const url = `${cloudUrls.deviceUrl}/v3/user/get_things`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new TclAuthError(`HTTP ${response.status} from get_things: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { code?: number; message?: string; data?: Record<string, unknown>[] };
  if (!Array.isArray(parsed.data)) {
    throw new TclAuthError(`Unexpected get_things response: ${text.slice(0, 300)}`);
  }

  return parsed.data.map((item) => {
    let room = firstString(item, ['room']);
    if (!room && Array.isArray(item.labels)) {
      const roomLabel = (item.labels as Record<string, unknown>[]).find((l) => l.labelKey === 'room');
      room = roomLabel ? String(roomLabel.labelValue) : undefined;
    }
    const nickName = firstString(item, ['nick_name', 'nickName']) ?? room ?? firstString(item, ['device_name', 'deviceName']) ?? 'TCL AC';
    return {
      deviceId: firstString(item, ['device_id', 'deviceId']) ?? '',
      productKey: firstString(item, ['product_key', 'productKey']),
      nickName,
      deviceName: firstString(item, ['device_name', 'deviceName']),
      category: firstString(item, ['category']),
      deviceType: firstString(item, ['device_type', 'deviceType']),
      firmwareVersion: firstString(item, ['firmware_version', 'firmwareVersion']),
      isOnline: Number(firstString(item, ['is_online', 'isOnline']) ?? 0) === 1,
      room,
    } satisfies TclThing;
  }).filter((thing) => thing.deviceId !== '');
}
