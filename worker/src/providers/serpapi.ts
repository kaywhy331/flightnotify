/**
 * SerpApi fare provider.
 *
 * Port of `flightnotify/providers/serpapi/{client,parsing,provider}.py`,
 * collapsed into one module because the Worker has no transport layer to swap:
 * there is only the global `fetch`, and the only seam tests need is a fetch
 * function they can supply.
 *
 * Nothing here invents a value. Fields absent from the provider payload stay
 * null rather than being filled with a plausible default, links are carried
 * through only when SerpApi supplied them, and the price is reported exactly as
 * received together with the scope label that says how to read it. Deriving a
 * party or per-traveler figure is domain/evaluation.ts's job -- doing it here
 * would bake an assumption into stored history that a later config change
 * could not undo.
 *
 * The API key exists in exactly one place: the query string of an outgoing
 * request. It is never in a fingerprint, a cache key, an excerpt, a log line,
 * or an error message -- provider text is redacted on the way into an error,
 * because SerpApi occasionally echoes the request URL back in one.
 */

import {
  Cabin,
  EndpointType,
  FlexDuration,
  StopsPreference,
  type CabinValue,
  type EndpointTypeValue,
  type FlexDurationValue,
  type PriceScopeValue,
  type StopsPreferenceValue,
} from "../domain/enums.js";
import { queryFingerprint } from "../domain/fingerprints.js";
import { centsFromDecimalString } from "../domain/money.js";
import type { Config } from "../env.js";
import { toIso } from "../time.js";
import {
  ProviderAuthError,
  ProviderError,
  ProviderMalformedResponseError,
  ProviderMissingCredentialsError,
  ProviderNetworkError,
  ProviderQuotaExhaustedError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnsupportedQueryError,
} from "./errors.js";
import {
  maskIdentifier,
  type AccountStatus,
  type ExactSearchQuery,
  type FareProvider,
  type FlexibleSearchQuery,
  type NormalizedOffer,
  type OfferLayover,
  type OfferSegment,
  type ParsePayloadOptions,
  type ProviderParams,
  type ProviderResult,
} from "./types.js";

/** Documented SerpApi encodings. */
export const CABIN_CODES: Record<CabinValue, number> = {
  [Cabin.ECONOMY]: 1,
  [Cabin.PREMIUM_ECONOMY]: 2,
  [Cabin.BUSINESS]: 3,
  [Cabin.FIRST]: 4,
};
export const STOPS_CODES: Record<StopsPreferenceValue, number> = {
  [StopsPreference.ANY]: 0,
  [StopsPreference.NONSTOP]: 1,
  [StopsPreference.ONE_STOP_MAX]: 2,
};
export const FLEX_DURATION_CODES: Record<FlexDurationValue, number> = {
  [FlexDuration.WEEKEND]: 1,
  [FlexDuration.ONE_WEEK]: 2,
  [FlexDuration.TWO_WEEKS]: 3,
};

/** Google Flights caps a single search at nine passengers. */
export const MAX_PASSENGERS = 9;
/** Lap infants may not outnumber the adults who would hold them. */
export const MAX_LAP_INFANTS_PER_ADULT = 1;

/**
 * SerpApi answers "no itineraries" with an HTTP 200 error string rather than an
 * empty result set. That is a legitimate outcome, not a failure.
 */
const NO_RESULTS_MARKERS = [
  "hasn't returned any results",
  "has not returned any results",
  "no results found",
  "returned no results",
];
const INVALID_KEY_MARKERS = ["invalid api key", "missing api key", "unauthorized"];
const QUOTA_MARKERS = ["run out of searches", "exceeded your", "no searches left", "account limit"];
const UNSUPPORTED_MARKERS = [
  "unsupported",
  "not supported",
  "invalid value",
  "missing query",
  "wrong request",
  "is not a valid",
];

/**
 * Keys copied into the stored debugging excerpt. Deliberately excludes
 * anything that could carry a credential.
 */
const SAFE_METADATA_KEYS = [
  "id",
  "status",
  "created_at",
  "processed_at",
  "total_time_taken",
  "google_flights_url",
  "google_travel_explore_url",
];
const SAFE_PARAM_KEYS = [
  "engine",
  "departure_id",
  "arrival_id",
  "outbound_date",
  "return_date",
  "type",
  "travel_class",
  "adults",
  "children",
  "infants_in_seat",
  "infants_on_lap",
  "stops",
  "currency",
  "gl",
  "hl",
  "month",
  "travel_duration",
  "include_airlines",
  "exclude_airlines",
];

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
/** Bound decompressed provider JSON well below the Worker's memory ceiling. */
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The provider answered successfully but matched no itinerary. */
export class NoResultsSignal extends Error {
  readonly providerMessage: string;
  requestCount = 1;

  constructor(message: string) {
    super(message);
    this.name = "NoResultsSignal";
    this.providerMessage = message;
  }
}

export interface SerpApiOptions {
  /**
   * Test seam. Resolved per call rather than captured, so a suite that swaps
   * the global after construction still gets its stub.
   */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so backoff jitter is deterministic under test. */
  random?: () => number;
}

// --------------------------------------------------------------- conversions
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ProviderMalformedResponseError(
      "SerpApi returned a response larger than the 8 MiB safety limit.",
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderMalformedResponseError(
          "SerpApi returned a response larger than the 8 MiB safety limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ProviderMalformedResponseError) throw error;
    throw new ProviderNetworkError("SerpApi response body could not be read.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A provider price as integer cents, or null when it cannot be tracked.
 *
 * Mirrors the Python `_decimal` helper: booleans are not numbers, thousands
 * separators are tolerated, and a non-positive amount is rejected rather than
 * stored as a zero that would poison the historical low. The value goes through
 * its decimal *string* -- 1042.5 becomes "1042.5" becomes 104250 -- so no
 * binary fraction ever multiplies its way into stored money.
 */
export function priceCentsFrom(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/,/g, "").trim().replace(/^\+/, "");
  try {
    const cents = centsFromDecimalString(text);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

function scalarText(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

/** Python's `int(value)`: truncating for numbers, integer literals only for strings. */
function toInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** `date.fromisoformat(value[:10])`: a real calendar date or nothing. */
function toDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
  const [year, month, day] = head.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return roundTrips ? head : null;
}

/**
 * When the provider says it answered. Falls back to now, which is the only
 * honest answer when the payload carries no timestamp of its own.
 */
function responseTime(payload: Record<string, unknown>): string {
  const metadata = payload["search_metadata"];
  if (isRecord(metadata)) {
    for (const key of ["processed_at", "created_at"]) {
      const raw = metadata[key];
      if (typeof raw !== "string") continue;
      // "2026-08-01 09:15:05 UTC" and the two ISO shapes SerpApi also emits.
      const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(raw.trim())
        ? `${raw.trim().slice(0, 19).replace(" ", "T")}Z`
        : raw.trim();
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) return toIso(parsed);
    }
  }
  return toIso(new Date());
}

function matches(message: string, markers: string[]): boolean {
  const lowered = message.toLowerCase();
  return markers.some((marker) => lowered.includes(marker));
}

// -------------------------------------------------------------- excerpt
/** A credential-free slice of the response, safe to persist. */
export function sanitizeExcerpt(payload: unknown): Record<string, unknown> {
  const excerpt: Record<string, unknown> = {};
  if (!isRecord(payload)) return excerpt;

  const metadata = payload["search_metadata"];
  if (isRecord(metadata)) {
    const kept: Record<string, unknown> = {};
    for (const key of SAFE_METADATA_KEYS) {
      if (key in metadata) kept[key] = metadata[key];
    }
    excerpt["search_metadata"] = kept;
  }

  const params = payload["search_parameters"];
  if (isRecord(params)) {
    const kept: Record<string, unknown> = {};
    for (const key of SAFE_PARAM_KEYS) {
      if (key in params) kept[key] = params[key];
    }
    excerpt["search_parameters"] = kept;
  }

  const insights = payload["price_insights"];
  if (isRecord(insights)) {
    excerpt["price_insights"] = {
      lowest_price: insights["lowest_price"] ?? null,
      price_level: insights["price_level"] ?? null,
      typical_price_range: insights["typical_price_range"] ?? null,
    };
  }
  return excerpt;
}

// ------------------------------------------------- Google Flights (exact)
export interface ParseExactOptions {
  market: string;
  currency: string;
  queryFingerprint: string;
  priceScope: PriceScopeValue;
  outboundDate: string | null;
  returnDate: string | null;
}

/**
 * Normalize an `engine=google_flights` response.
 *
 * For a round trip the first response lists *outbound* options priced as the
 * complete round trip; enumerating individual return legs needs a second
 * billable search per itinerary, which FlightNotify deliberately does not
 * spend. The provider's own search URL is carried through as the link.
 */
export function parseGoogleFlights(
  payload: unknown,
  options: ParseExactOptions,
): ProviderResult {
  if (!isRecord(payload)) {
    throw new ProviderMalformedResponseError("Google Flights response was not a JSON object.");
  }

  const groups: Record<string, unknown>[] = [];
  for (const key of ["best_flights", "other_flights"]) {
    const value = payload[key];
    if (Array.isArray(value)) groups.push(...value.filter(isRecord));
  }

  const metadata = payload["search_metadata"];
  const searchLink = isRecord(metadata) ? asStringOrNull(metadata["google_flights_url"]) : null;

  let { outboundDate, returnDate, currency } = options;
  const params = payload["search_parameters"];
  if (isRecord(params)) {
    // The caller's requested dates win: for an exact-date search FlightNotify
    // knows which combination it asked for, and echoing the response back over
    // it would mislabel the run. The echo is only a fallback.
    outboundDate = outboundDate ?? toDateOnly(params["outbound_date"]);
    returnDate = returnDate ?? toDateOnly(params["return_date"]);
    currency = String(asStringOrNull(params["currency"]) || currency).toUpperCase();
  }

  const offers: NormalizedOffer[] = [];
  for (const item of groups) {
    const offer = googleFlightsOffer(item, {
      market: options.market,
      currency,
      priceScope: options.priceScope,
      outboundDate,
      returnDate,
      searchLink,
    });
    if (offer !== null) offers.push(offer);
  }

  return {
    endpoint: EndpointType.GOOGLE_FLIGHTS,
    market: options.market,
    currency,
    queryFingerprint: options.queryFingerprint,
    offers,
    responseAt: responseTime(payload),
    requestCount: 1,
    searchLink,
    outboundDate,
    returnDate,
    rawExcerpt: sanitizeExcerpt(payload),
    fromCache: false,
  };
}

function googleFlightsOffer(
  item: Record<string, unknown>,
  context: {
    market: string;
    currency: string;
    priceScope: PriceScopeValue;
    outboundDate: string | null;
    returnDate: string | null;
    searchLink: string | null;
  },
): NormalizedOffer | null {
  const priceCents = priceCentsFrom(item["price"]);
  // An itinerary without a usable price cannot be tracked; skip it rather than
  // storing a zero that would poison the historical low.
  if (priceCents === null) return null;

  const rawSegments = Array.isArray(item["flights"]) ? item["flights"].filter(isRecord) : [];
  const segments: OfferSegment[] = [];
  const airlines: string[] = [];
  const flightNumbers: string[] = [];
  let cabin: string | null = null;

  for (const segment of rawSegments) {
    const departure = isRecord(segment["departure_airport"]) ? segment["departure_airport"] : {};
    const arrival = isRecord(segment["arrival_airport"]) ? segment["arrival_airport"] : {};
    const entry: OfferSegment = {
      departure_id: asStringOrNull(departure["id"]),
      departure_name: asStringOrNull(departure["name"]),
      departure_time: asStringOrNull(departure["time"]),
      arrival_id: asStringOrNull(arrival["id"]),
      arrival_name: asStringOrNull(arrival["name"]),
      arrival_time: asStringOrNull(arrival["time"]),
      airline: asStringOrNull(segment["airline"]),
      flight_number: asStringOrNull(segment["flight_number"]),
      travel_class: asStringOrNull(segment["travel_class"]),
      duration_minutes: toInt(segment["duration"]),
      airplane: asStringOrNull(segment["airplane"]),
      overnight: asBoolOrNull(segment["overnight"]),
    };
    segments.push(entry);
    if (entry.airline && !airlines.includes(entry.airline)) airlines.push(entry.airline);
    if (entry.flight_number) flightNumbers.push(entry.flight_number);
    if (cabin === null && entry.travel_class) cabin = entry.travel_class;
  }

  const rawLayovers = Array.isArray(item["layovers"]) ? item["layovers"].filter(isRecord) : [];
  const layovers: OfferLayover[] = rawLayovers.map((layover) => ({
    id: asStringOrNull(layover["id"]),
    name: asStringOrNull(layover["name"]),
    duration_minutes: toInt(layover["duration"]),
    overnight: asBoolOrNull(layover["overnight"]),
  }));

  const first = segments[0];
  const last = segments[segments.length - 1];
  const stops =
    layovers.length > 0
      ? layovers.length
      : segments.length > 0
        ? Math.max(0, segments.length - 1)
        : null;

  return {
    priceCents,
    currency: context.currency,
    priceScope: context.priceScope,
    market: context.market,
    origin: first?.departure_id ?? null,
    destination: last?.arrival_id ?? null,
    outboundDate: toDateOnly(first?.departure_time) ?? context.outboundDate,
    returnDate: context.returnDate,
    departureTime: first?.departure_time ?? null,
    arrivalTime: last?.arrival_time ?? null,
    airlines,
    flightNumbers,
    stops,
    durationMinutes: toInt(item["total_duration"]),
    cabin,
    segments,
    layovers,
    // A booking link requires a second billable search, so none is invented.
    bookingLink: null,
    searchLink: context.searchLink,
  };
}

// ---------------------------------------------- Google Travel Explore (flex)
export interface ParseFlexibleOptions {
  market: string;
  currency: string;
  queryFingerprint: string;
  priceScope: PriceScopeValue;
}

/**
 * Normalize a route-specific `engine=google_travel_explore` response.
 *
 * The provider chooses the actual dates for a flexible month; those dates are
 * preserved verbatim as `start_date` / `end_date` rather than recomputed here.
 */
export function parseGoogleTravelExplore(
  payload: unknown,
  options: ParseFlexibleOptions,
): ProviderResult {
  if (!isRecord(payload)) {
    throw new ProviderMalformedResponseError("Travel Explore response was not a JSON object.");
  }

  const flights = Array.isArray(payload["flights"]) ? payload["flights"].filter(isRecord) : [];
  if (flights.length === 0 && "destinations" in payload) {
    throw new ProviderMalformedResponseError(
      "Travel Explore answered with destination suggestions instead of " +
        "route flights. FlightNotify needs a specific arrival airport.",
    );
  }

  const outboundDate = toDateOnly(payload["start_date"]);
  const returnDate = toDateOnly(payload["end_date"]);
  let searchLink = asStringOrNull(payload["google_flights_link"]);
  if (!searchLink) {
    const metadata = payload["search_metadata"];
    searchLink = isRecord(metadata)
      ? asStringOrNull(metadata["google_travel_explore_url"])
      : null;
  }

  let currency = options.currency;
  const params = payload["search_parameters"];
  if (isRecord(params)) {
    currency = String(asStringOrNull(params["currency"]) || currency).toUpperCase();
  }

  const offers: NormalizedOffer[] = [];
  for (const flight of flights) {
    const priceCents = priceCentsFrom(flight["price"]);
    if (priceCents === null) continue;
    const departure = isRecord(flight["departure_airport"]) ? flight["departure_airport"] : {};
    const arrival = isRecord(flight["arrival_airport"]) ? flight["arrival_airport"] : {};
    const airline = asStringOrNull(flight["airline"]);
    const durationMinutes = toInt(flight["duration"]);

    offers.push({
      priceCents,
      currency,
      priceScope: options.priceScope,
      market: options.market,
      origin: asStringOrNull(departure["id"]),
      destination: asStringOrNull(arrival["id"]),
      outboundDate,
      returnDate,
      departureTime: null,
      arrivalTime: null,
      airlines: airline ? [airline] : [],
      flightNumbers: [],
      stops: toInt(flight["number_of_stops"]),
      durationMinutes,
      cabin: null,
      segments: [
        {
          departure_id: asStringOrNull(departure["id"]),
          departure_name: asStringOrNull(departure["name"]),
          arrival_id: asStringOrNull(arrival["id"]),
          arrival_name: asStringOrNull(arrival["name"]),
          airline,
          airline_code: asStringOrNull(flight["airline_code"]),
          duration_minutes: durationMinutes,
          cheapest_flight: flight["cheapest_flight"] === true,
        },
      ],
      layovers: [],
      bookingLink: null,
      searchLink,
    });
  }

  return {
    endpoint: EndpointType.GOOGLE_TRAVEL_EXPLORE,
    market: options.market,
    currency,
    queryFingerprint: options.queryFingerprint,
    offers,
    responseAt: responseTime(payload),
    requestCount: 1,
    searchLink,
    outboundDate,
    returnDate,
    rawExcerpt: sanitizeExcerpt(payload),
    fromCache: false,
  };
}

// ------------------------------------------------------------------ adapter
export class SerpApiProvider implements FareProvider {
  readonly name = "serpapi";

  private readonly config: Config;
  private readonly injectedFetch: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(config: Config, options: SerpApiOptions = {}) {
    this.config = config;
    this.injectedFetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  // -- capability ---------------------------------------------------------
  isConfigured(): boolean {
    return this.config.serpapiApiKey.trim() !== "";
  }

  supportsFlexible(): boolean {
    return true;
  }

  get priceScope(): PriceScopeValue {
    return this.config.priceScope;
  }

  get exactEndpoint(): EndpointTypeValue {
    return EndpointType.GOOGLE_FLIGHTS;
  }

  get flexibleEndpoint(): EndpointTypeValue {
    return EndpointType.GOOGLE_TRAVEL_EXPLORE;
  }

  get maxRequestCount(): number {
    return this.maxAttempts;
  }

  // -- cache replay -------------------------------------------------------
  parsePayload(payload: unknown, options: ParsePayloadOptions): ProviderResult {
    if (options.flexible) {
      return parseGoogleTravelExplore(payload, {
        market: options.market,
        currency: options.currency,
        queryFingerprint: options.queryFingerprint,
        priceScope: this.priceScope,
      });
    }
    return parseGoogleFlights(payload, {
      market: options.market,
      currency: options.currency,
      queryFingerprint: options.queryFingerprint,
      priceScope: this.priceScope,
      outboundDate: options.outboundDate ?? null,
      returnDate: options.returnDate ?? null,
    });
  }

  // -- searches -----------------------------------------------------------
  /** Request parameters for the Google Flights engine (no credentials). */
  buildExactParams(query: ExactSearchQuery): ProviderParams {
    const params: ProviderParams = {
      engine: "google_flights",
      departure_id: query.origin.toUpperCase(),
      arrival_id: query.destination.toUpperCase(),
      outbound_date: query.outboundDate,
      return_date: query.returnDate,
      type: 1, // round trip
      travel_class: CABIN_CODES[query.cabin],
      adults: query.party.adults,
      children: query.party.children,
      infants_in_seat: query.party.infantsInSeat,
      infants_on_lap: query.party.infantsOnLap,
      currency: query.currency.toUpperCase(),
      gl: query.market.toLowerCase(),
      hl: "en",
      sort_by: 2, // price
    };
    const stopsCode = STOPS_CODES[query.stops];
    if (stopsCode) params["stops"] = stopsCode;
    if (query.includeAirlines) {
      params["include_airlines"] = query.includeAirlines;
    } else if (query.excludeAirlines) {
      // SerpApi rejects both filters together.
      params["exclude_airlines"] = query.excludeAirlines;
    }
    return params;
  }

  async searchExact(query: ExactSearchQuery): Promise<ProviderResult> {
    this.requireCredentials();
    const params = this.buildExactParams(query);
    const fingerprint = await queryFingerprint(EndpointType.GOOGLE_FLIGHTS, params);
    try {
      const response = await this.search(params);
      const result = parseGoogleFlights(response.payload, {
        market: query.market,
        currency: query.currency,
        queryFingerprint: fingerprint,
        priceScope: this.priceScope,
        outboundDate: query.outboundDate,
        returnDate: query.returnDate,
      });
      return { ...result, requestCount: response.requestCount };
    } catch (error) {
      if (error instanceof NoResultsSignal) {
        return this.emptyResult(
          EndpointType.GOOGLE_FLIGHTS,
          query.market,
          query.currency,
          fingerprint,
          query.outboundDate,
          query.returnDate,
          error.requestCount,
        );
      }
      throw error;
    }
  }

  /** Request parameters for the Google Travel Explore engine. */
  buildFlexibleParams(query: FlexibleSearchQuery): ProviderParams {
    const params: ProviderParams = {
      engine: "google_travel_explore",
      departure_id: query.origin.toUpperCase(),
      arrival_id: query.destination.toUpperCase(),
      type: 1, // round trip
      month: query.month,
      travel_duration: FLEX_DURATION_CODES[query.duration],
      travel_class: CABIN_CODES[query.cabin],
      adults: query.party.adults,
      children: query.party.children,
      infants_in_seat: query.party.infantsInSeat,
      infants_on_lap: query.party.infantsOnLap,
      currency: query.currency.toUpperCase(),
      gl: query.market.toLowerCase(),
      hl: "en",
      travel_mode: 1, // flights only
    };
    const stopsCode = STOPS_CODES[query.stops];
    if (stopsCode) params["stops"] = stopsCode;
    if (query.includeAirlines) {
      params["include_airlines"] = query.includeAirlines;
    } else if (query.excludeAirlines) {
      params["exclude_airlines"] = query.excludeAirlines;
    }
    return params;
  }

  async searchFlexible(query: FlexibleSearchQuery): Promise<ProviderResult> {
    this.requireCredentials();
    const params = this.buildFlexibleParams(query);
    const fingerprint = await queryFingerprint(EndpointType.GOOGLE_TRAVEL_EXPLORE, params);
    try {
      const response = await this.search(params);
      const result = parseGoogleTravelExplore(response.payload, {
        market: query.market,
        currency: query.currency,
        queryFingerprint: fingerprint,
        priceScope: this.priceScope,
      });
      return { ...result, requestCount: response.requestCount };
    } catch (error) {
      if (error instanceof NoResultsSignal) {
        return this.emptyResult(
          EndpointType.GOOGLE_TRAVEL_EXPLORE,
          query.market,
          query.currency,
          fingerprint,
          null,
          null,
          error.requestCount,
        );
      }
      throw error;
    }
  }

  // -- account ------------------------------------------------------------
  /** Free per SerpApi's documentation; never counted as a fare search. */
  async accountStatus(): Promise<AccountStatus> {
    this.requireCredentials();
    const { payload } = await this.request("/account.json", {}, false);
    return {
      planName: asStringOrNull(payload["plan_name"]),
      searchesPerMonth: toInt(payload["searches_per_month"]),
      searchesLeft: toInt(payload["total_searches_left"]),
      thisMonthUsage: toInt(payload["this_month_usage"]),
      rateLimitPerHour: toInt(payload["account_rate_limit_per_hour"]),
      accountEmailMasked: maskIdentifier(asStringOrNull(payload["account_email"])),
      fetchedAt: toIso(new Date()),
    };
  }

  // -- transport ----------------------------------------------------------
  /** Call `/search.json`. Throws `NoResultsSignal` for an empty match. */
  private async search(
    params: ProviderParams,
  ): Promise<{ payload: Record<string, unknown>; requestCount: number }> {
    return this.request("/search.json", params, true);
  }

  private async request(
    path: string,
    params: ProviderParams,
    allowNoResults: boolean,
  ): Promise<{ payload: Record<string, unknown>; requestCount: number }> {
    let lastError: ProviderError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const payload = await this.singleRequest(path, params);
        return { payload: this.interpret(payload, allowNoResults), requestCount: attempt };
      } catch (error) {
        if (error instanceof ProviderError || error instanceof NoResultsSignal) {
          error.requestCount = attempt;
        }
        const transient =
          error instanceof ProviderTimeoutError || error instanceof ProviderNetworkError;
        if (!transient || attempt >= this.maxAttempts) throw error;
        lastError = error;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
    }
    throw lastError ?? new ProviderNetworkError("SerpApi request failed.");
  }

  private async singleRequest(
    path: string,
    params: ProviderParams,
  ): Promise<Record<string, unknown>> {
    if (this.config.offlineMode) {
      // OFFLINE_MODE is the suite's guarantee that a test run cannot spend the
      // owner's real quota, so it refuses before the request exists rather than
      // relying on a stub being in place.
      throw new ProviderNetworkError(
        "OFFLINE_MODE is set, so no request was made to SerpApi.",
      );
    }

    const url = new URL(`${this.config.serpapiBaseUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api_key", this.config.serpapiApiKey);
    if (!url.searchParams.has("output")) url.searchParams.set("output", "json");

    const doFetch = this.injectedFetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        // The only timeout mechanism that works in a Worker.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderTimeoutError(`SerpApi timed out after ${this.timeoutMs}ms`);
      }
      // The thrown message can echo the request URL, which carries the api_key.
      // Only the error's type is surfaced.
      throw new ProviderNetworkError(`SerpApi request failed: ${name}`);
    }

    return this.decode(response);
  }

  private async decode(response: Response): Promise<Record<string, unknown>> {
    const status = response.status;
    let payload: Record<string, unknown> = {};
    try {
      const body: unknown = JSON.parse(await boundedResponseText(response));
      if (isRecord(body)) payload = body;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      payload = {};
    }

    const message = this.redact(scalarText(payload["error"]).trim());

    if (status === 401 || (message && matches(message, INVALID_KEY_MARKERS))) {
      throw new ProviderAuthError(message || "SerpApi returned HTTP 401.");
    }
    if (status === 429) {
      if (matches(message, QUOTA_MARKERS)) throw new ProviderQuotaExhaustedError(message);
      throw new ProviderRateLimitError(
        message || "SerpApi returned HTTP 429.",
        retryAfterSeconds(response),
      );
    }
    if ((status === 402 || status === 403) && matches(message, QUOTA_MARKERS)) {
      throw new ProviderQuotaExhaustedError(message);
    }
    if (status >= 500) throw new ProviderNetworkError(`SerpApi returned HTTP ${status}.`);
    if (status >= 400 && !message) throw new ProviderError(`SerpApi returned HTTP ${status}.`);

    return payload;
  }

  private interpret(
    payload: Record<string, unknown>,
    allowNoResults: boolean,
  ): Record<string, unknown> {
    const metadata = payload["search_metadata"];
    let message = this.redact(scalarText(payload["error"]).trim());
    if (!message && isRecord(metadata) && metadata["status"] === "Error") {
      message = this.redact(
        scalarText(metadata["error"], "SerpApi reported an error status.").trim(),
      );
    }

    if (message) {
      if (matches(message, INVALID_KEY_MARKERS)) throw new ProviderAuthError(message);
      if (matches(message, QUOTA_MARKERS)) throw new ProviderQuotaExhaustedError(message);
      if (allowNoResults && matches(message, NO_RESULTS_MARKERS)) {
        throw new NoResultsSignal(message);
      }
      if (matches(message, UNSUPPORTED_MARKERS)) {
        throw new ProviderUnsupportedQueryError(
          message,
          `SerpApi rejected this search: ${message} Nothing was stored ` +
            "for this check and existing history is unchanged. Adjust the " +
            "route, dates, cabin, market or passenger counts.",
        );
      }
      throw new ProviderUnsupportedQueryError(message);
    }

    if (Object.keys(payload).length === 0) {
      throw new ProviderMalformedResponseError("SerpApi returned an empty response body.");
    }
    return payload;
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(2 ** (attempt - 1), 8);
    return (base + this.random() * 0.5) * 1000;
  }

  /**
   * Remove the key from provider-supplied text. SerpApi sometimes quotes the
   * request URL back, and that text ends up in `search_runs.error_message`.
   * Short keys are left alone: a two-character "key" would shred the message.
   */
  private redact(text: string): string {
    const key = this.config.serpapiApiKey.trim();
    if (key.length < 8 || !text.includes(key)) return text;
    return text.split(key).join("[redacted]");
  }

  // -- helpers ------------------------------------------------------------
  private requireCredentials(): void {
    if (!this.isConfigured()) throw new ProviderMissingCredentialsError();
  }

  /** A successful call that matched nothing. Still counted as billable. */
  private emptyResult(
    endpoint: EndpointTypeValue,
    market: string,
    currency: string,
    fingerprint: string,
    outboundDate: string | null,
    returnDate: string | null,
    requestCount = 1,
  ): ProviderResult {
    return {
      endpoint,
      market,
      currency,
      queryFingerprint: fingerprint,
      offers: [],
      responseAt: toIso(new Date()),
      requestCount,
      searchLink: null,
      outboundDate,
      returnDate,
      // Python passes the provider's message through `sanitize_excerpt`, whose
      // allowlist drops it, so the excerpt is empty here too. Reproduced rather
      // than fixed: the excerpt column's contents are compared across the
      // Python and Worker implementations.
      rawExcerpt: {},
      fromCache: false,
    };
  }
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Provider passenger-limit checks. Returns human-readable problems. */
export function validateParty(
  adults: number,
  children: number,
  infantsInSeat: number,
  infantsOnLap: number,
): string[] {
  const problems: string[] = [];
  if (adults < 1) problems.push("At least one adult is required.");
  for (const [label, value] of [
    ["Children", children],
    ["Infants in seat", infantsInSeat],
    ["Lap infants", infantsOnLap],
  ] as const) {
    if (value < 0) problems.push(`${label} cannot be negative.`);
  }
  const total = adults + children + infantsInSeat + infantsOnLap;
  if (total > MAX_PASSENGERS) {
    problems.push(
      `Google Flights allows at most ${MAX_PASSENGERS} passengers in one search; ` +
        `this tracker has ${total}.`,
    );
  }
  if (infantsOnLap > adults * MAX_LAP_INFANTS_PER_ADULT) {
    problems.push("Each lap infant needs its own adult.");
  }
  return problems;
}
