import type { OpenAIClient } from '../../clients/openai/openai.client';
import { OpenAIModel } from '../../common/enums';

/** Matches {@link FlowToolExecutionContext} — duplicated here to avoid circular imports with the executor. */
export interface GetWeatherToolContext {
  slots: Record<string, unknown>;
  companyId?: string;
  callSid?: string;
  phoneNumberTo?: string;
  phoneNumberFrom?: string;
  flowId?: string;
  language?: string;
  openaiClient?: OpenAIClient;
}

/** WMO Weather interpretation codes (WW) — simplified labels for Open-Meteo `weather_code`. */
function describeWeatherCode(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return map[code] ?? `Weather code ${String(code)}`;
}

function slotLocationToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Keys we never want to mistake for a location, even though they're plain strings on `args`. */
const NON_LOCATION_ARG_KEYS = new Set(['date', 'unit', 'units', 'language', 'format', 'timezone']);

function pickLocationArg(args: Record<string, unknown>, ctx: GetWeatherToolContext): string {
  const fromArgs =
    (typeof args.location === 'string' && args.location.trim()) ||
    (typeof args.city === 'string' && args.city.trim()) ||
    (typeof args.place === 'string' && args.place.trim());
  if (fromArgs) return fromArgs.trim();

  // The model sometimes names the parameter differently, or a bare reply like "Lahore" (with no
  // surrounding sentence) gets passed under a key we didn't anticipate — fall back to any other
  // non-empty string argument before giving up on `args` entirely.
  for (const [key, value] of Object.entries(args)) {
    if (NON_LOCATION_ARG_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return slotLocationToString(ctx.slots.location);
}

/** True if `text` has letters outside the Latin alphabet (e.g. Urdu/Arabic, Devanagari). */
function hasNonLatinLetters(text: string): boolean {
  return /[^\u0020-\u024F\u1E00-\u1EFF\s.,'-]/.test(text);
}

/**
 * Open-Meteo's geocoder is keyed on Latin-script place names — querying it with the Arabic-script
 * Urdu (or Devanagari Hindi, when STT mislabels Urdu speech) place name returned by slot capture
 * yields zero results, even though the place name itself is valid. Transliterate to the English
 * name first so geocoding can actually find it.
 */
async function toEnglishPlaceName(location: string, openaiClient?: OpenAIClient): Promise<string> {
  if (!hasNonLatinLetters(location) || !openaiClient) return location;
  try {
    const result = await openaiClient.chatCompletion(
      [
        {
          role: 'system',
          content:
            'You output only the common English name of a place, nothing else. No quotes, no explanation.',
        },
        {
          role: 'user',
          content: `What is the common English name for this place: "${location}"? If it is not a real place, repeat it unchanged.`,
        },
      ],
      OpenAIModel.GPT_4O_MINI,
      { temperature: 0, maxTokens: 20 },
    );
    const cleaned = result.trim().replace(/^["']|["']$/g, '');
    return cleaned.length >= 2 ? cleaned : location;
  } catch {
    return location;
  }
}

/**
 * Flow tool handler: geocode `location` via Open-Meteo, then fetch current conditions.
 * Register as `executorKey: "get_weather"` on your flow tool definition.
 *
 * Returns JSON string suitable for LLM follow-up (temperature °C, description, etc.).
 */
export async function getWeatherFlowToolHandler(
  args: Record<string, unknown>,
  ctx: GetWeatherToolContext,
): Promise<string> {
  const location = pickLocationArg(args, ctx);
  if (!location) {
    return JSON.stringify({
      ok: false,
      error: 'missing_location',
      message: 'No location provided. Ask the user which city or place to check.',
    });
  }

  try {
    const geoQuery = await toEnglishPlaceName(location, ctx.openaiClient);
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(geoQuery)}&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl, { headers: { Accept: 'application/json' } });
    if (!geoRes.ok) {
      return JSON.stringify({
        ok: false,
        error: 'geocode_http',
        status: geoRes.status,
        location_query: location,
      });
    }
    const geoJson = (await geoRes.json()) as {
      results?: {
        name: string;
        latitude: number;
        longitude: number;
        country?: string;
        admin1?: string;
      }[];
    };
    const hit = geoJson.results?.[0];
    if (!hit) {
      return JSON.stringify({
        ok: false,
        error: 'location_not_found',
        message: `Could not find a place named "${location}". Ask for spelling or a nearby city.`,
        location_query: location,
      });
    }

    const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
    forecastUrl.searchParams.set('latitude', String(hit.latitude));
    forecastUrl.searchParams.set('longitude', String(hit.longitude));
    forecastUrl.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
    );
    forecastUrl.searchParams.set('timezone', 'auto');

    const fcRes = await fetch(forecastUrl.toString(), { headers: { Accept: 'application/json' } });
    if (!fcRes.ok) {
      return JSON.stringify({
        ok: false,
        error: 'forecast_http',
        status: fcRes.status,
        resolved_name: hit.name,
      });
    }
    const fcJson = (await fcRes.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const cur = fcJson.current;
    if (!cur || typeof cur.temperature_2m !== 'number') {
      return JSON.stringify({
        ok: false,
        error: 'no_current_weather',
        resolved_name: hit.name,
      });
    }

    const code = typeof cur.weather_code === 'number' ? cur.weather_code : 0;
    const description = describeWeatherCode(code);
    const displayPlace = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');

    const payload = {
      ok: true,
      resolved_location: displayPlace,
      location_query: location,
      latitude: hit.latitude,
      longitude: hit.longitude,
      temperature_c: Math.round(cur.temperature_2m * 10) / 10,
      weather_description: description,
      weather_summary: `${description}, ${String(Math.round(cur.temperature_2m * 10) / 10)}°C`,
      humidity_percent:
        typeof cur.relative_humidity_2m === 'number' ? Math.round(cur.relative_humidity_2m) : null,
      wind_speed_kmh:
        typeof cur.wind_speed_10m === 'number' ? Math.round(cur.wind_speed_10m * 10) / 10 : null,
      weather_code: code,
    };

    return JSON.stringify(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      ok: false,
      error: 'get_weather_failed',
      message,
      location_query: location,
    });
  }
}
