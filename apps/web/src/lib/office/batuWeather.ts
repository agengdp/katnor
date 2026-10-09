/**
 * Weather persona for the office, following real Batu city (Malang
 * highlands) conditions via Open-Meteo (free, keyless, CORS-open):
 * clear Batu mornings light the room warm, overcast afternoons dim it,
 * drizzle/rain/storm show outside the windows, night goes dark.
 *
 * Pure data + fetch, no Three.js — threeOffice.ts consumes `kind` while
 * ThreeOffice.svelte owns polling. When the API is unreachable the room
 * falls back to a Batu-local time-of-day heuristic (Asia/Jakarta hour),
 * clearly marked `live: false` so the badge can say "perkiraan".
 */

export type BatuWeatherKind =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'storm';

export interface BatuWeatherState {
  kind: BatuWeatherKind;
  /** Rounded °C, null when on the time-of-day fallback. */
  tempC: number | null;
  isDay: boolean;
  live: boolean;
}

interface WeatherMeta {
  label: string;
  dayIcon: string;
  nightIcon: string;
  /** Persona line shown as the badge tooltip. */
  desc: string;
}

export const WEATHER_META: Record<BatuWeatherKind, WeatherMeta> = {
  clear: {
    label: 'Cerah',
    dayIcon: '☀️',
    nightIcon: '🌙',
    desc: 'Langit biru Batu — matahari pegunungan masuk lewat jendela',
  },
  partly: {
    label: 'Berawan',
    dayIcon: '🌤️',
    nightIcon: '☁️',
    desc: 'Awan gunung lewat pelan di atas Batu',
  },
  cloudy: {
    label: 'Mendung',
    dayIcon: '☁️',
    nightIcon: '☁️',
    desc: 'Langit Batu kelabu — lampu ruangan nyala',
  },
  fog: {
    label: 'Berkabut',
    dayIcon: '🌫️',
    nightIcon: '🌫️',
    desc: 'Kabut pegunungan turun menyelimuti Batu',
  },
  drizzle: {
    label: 'Gerimis',
    dayIcon: '🌦️',
    nightIcon: '🌦️',
    desc: 'Rintik halus di luar jendela kantor',
  },
  rain: {
    label: 'Hujan',
    dayIcon: '🌧️',
    nightIcon: '🌧️',
    desc: 'Hujan pegunungan turun di Batu',
  },
  storm: {
    label: 'Badai',
    dayIcon: '⛈️',
    nightIcon: '⛈️',
    desc: 'Badai di Batu — petir sesekali menyambar',
  },
};

/** Batu city center, highlands of Malang. */
const BATU_LAT = -7.867;
const BATU_LON = 112.524;

/**
 * WMO weather-code mapping, tuned for a tropical highland city (Batu
 * never sees snow, so snow codes fall through to rain).
 */
export function mapWeatherCode(code: number): BatuWeatherKind {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code === 51 || code === 53 || code === 55 || code === 56 || code === 57) return 'drizzle';
  if (code === 80) return 'drizzle';
  if (code === 95 || code === 96 || code === 99) return 'storm';
  return 'rain';
}

/** Batu-local hour (Asia/Jakarta), regardless of the browser's timezone. */
export function batuHour(now: Date): number {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
}

/**
 * Offline stand-in with Batu's daily rhythm: clear cool mornings, clouds
 * building toward the afternoon, night clear and dark.
 */
export function fallbackWeather(now: Date): BatuWeatherState {
  const h = batuHour(now);
  const isDay = h >= 6 && h < 18;
  let kind: BatuWeatherKind = 'clear';
  if (h >= 11 && h < 15) kind = 'partly';
  else if (h >= 15 && h < 18) kind = 'cloudy';
  return { kind, tempC: null, isDay, live: false };
}

interface OpenMeteoCurrent {
  temperature_2m: number;
  weather_code: number;
  is_day: number;
}

/** Live Batu conditions; throws on network or shape errors. */
export async function fetchBatuWeather(): Promise<BatuWeatherState> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${BATU_LAT}&longitude=${BATU_LON}` +
    `&current=temperature_2m,weather_code,is_day&timezone=Asia%2FJakarta`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const json = (await res.json()) as { current?: Partial<OpenMeteoCurrent> };
    const current = json.current;
    if (
      !current ||
      typeof current.temperature_2m !== 'number' ||
      typeof current.weather_code !== 'number' ||
      typeof current.is_day !== 'number'
    ) {
      throw new Error('open-meteo shape');
    }
    return {
      kind: mapWeatherCode(current.weather_code),
      tempC: Math.round(current.temperature_2m),
      isDay: current.is_day === 1,
      live: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
