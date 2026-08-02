/**
 * Stable hashes for provider queries, itineraries, configs and alerts.
 *
 * Port of `flightnotify/domain/fingerprints.py`. Every digest is SHA-256 over
 * the canonical JSON encoding, so the same logical input produces the same key
 * across processes, restarts -- and now across the Python/TypeScript boundary,
 * which is what lets the existing production rows keep their meaning after
 * import.
 *
 * These are async because WebCrypto is; the Python originals were sync.
 */

import { canonicalJson, type CanonicalInput } from "./canonical.js";
import { decimalStringFromCents } from "./money.js";

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function digest(payload: CanonicalInput): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

/** Parameters that must never enter a cache/---fingerprint key. */
const EXCLUDED_QUERY_PARAMS = new Set(["api_key", "output", "no_cache"]);

/** Identify a provider request. The API key is never part of the key. */
export async function queryFingerprint(
  endpoint: string,
  params: Record<string, CanonicalInput>,
): Promise<string> {
  const scrubbed: Record<string, CanonicalInput> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!EXCLUDED_QUERY_PARAMS.has(key)) scrubbed[key] = value;
  }
  return digest({ endpoint, params: scrubbed });
}

export interface ItineraryFingerprintArgs {
  origin: string | null;
  destination: string | null;
  outbound_date: string | null;
  return_date: string | null;
  flight_numbers: string[] | null;
  departure_time: string | null;
  arrival_time: string | null;
  stops: number | null;
  market: string;
}

/** Identify a specific itinerary so repeats can be deduplicated. */
export async function itineraryFingerprint(
  args: ItineraryFingerprintArgs,
): Promise<string> {
  return digest({
    origin: args.origin,
    destination: args.destination,
    outbound_date: args.outbound_date,
    return_date: args.return_date,
    // Python coerces a missing list to [], which survives canonicalisation
    // (an empty list is not None), so it must not become a dropped key here.
    flight_numbers: args.flight_numbers ?? [],
    departure_time: args.departure_time,
    arrival_time: args.arrival_time,
    stops: args.stops,
    market: args.market,
  });
}

/** Identify a comparison series (comparison-relevant settings only). */
export async function configFingerprint(
  payload: Record<string, CanonicalInput>,
): Promise<string> {
  return digest(payload);
}

export interface AlertDedupeArgs {
  tracker_id: number;
  config_version_id: number | null;
  alert_type: string;
  price_cents: number;
  currency: string;
  itinerary_fingerprint_value: string | null;
  outbound_date: string | null;
  return_date: string | null;
  market: string | null;
}

/**
 * A repeat of the same finding must map to the same key.
 *
 * The price is rendered through `decimalStringFromCents`, which reproduces
 * Python's `format(Decimal.normalize(), "f")`. That is why $1042 and $1042.00
 * collapse to one key instead of alerting twice for the same fare.
 */
export async function alertDedupeKey(args: AlertDedupeArgs): Promise<string> {
  return digest({
    tracker_id: args.tracker_id,
    config_version_id: args.config_version_id,
    alert_type: args.alert_type,
    price: decimalStringFromCents(args.price_cents),
    currency: args.currency,
    itinerary: args.itinerary_fingerprint_value,
    outbound_date: args.outbound_date,
    return_date: args.return_date,
    market: args.market,
  });
}
