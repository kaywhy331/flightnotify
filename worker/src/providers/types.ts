/**
 * Provider-neutral query and result types.
 *
 * Port of `flightnotify/providers/base.py`. Two shapes change on the way over:
 * money is an integer count of cents (see domain/money.ts) and calendar dates
 * are `YYYY-MM-DD` strings. Both are what D1 stores and what the fingerprints
 * hash, so keeping a `Decimal`-shaped float or a `Date` here would only give a
 * binary fraction or a timezone somewhere to creep into a value that has
 * neither.
 *
 * The contract below is what the tracking domain depends on. Request shaping
 * and payload parsing are part of it rather than implementation detail,
 * because the cache stores a provider's own parameters as the fingerprint and
 * replays its own payloads: a provider has to be able to build and read both.
 */

import type {
  CabinValue,
  EndpointTypeValue,
  FlexDurationValue,
  PriceScopeValue,
  StopsPreferenceValue,
} from "../domain/enums.js";

export interface PassengerParty {
  adults: number;
  children: number;
  infantsInSeat: number;
  infantsOnLap: number;
}

/** Defaults matching the Python dataclass: one adult, nobody else. */
export function makeParty(overrides: Partial<PassengerParty> = {}): PassengerParty {
  return { adults: 1, children: 0, infantsInSeat: 0, infantsOnLap: 0, ...overrides };
}

/** Seats sold. Lap infants are excluded -- they occupy no seat. */
export function payingTravelers(party: PassengerParty): number {
  return party.adults + party.children + party.infantsInSeat;
}

export function totalTravelers(party: PassengerParty): number {
  return payingTravelers(party) + party.infantsOnLap;
}

/** A fixed outbound/return round trip in one country market. */
export interface ExactSearchQuery {
  origin: string;
  destination: string;
  /** YYYY-MM-DD. */
  outboundDate: string;
  /** YYYY-MM-DD. */
  returnDate: string;
  party: PassengerParty;
  cabin: CabinValue;
  stops: StopsPreferenceValue;
  currency: string;
  market: string;
  includeAirlines?: string | null;
  excludeAirlines?: string | null;
}

/** A route-specific flexible search (month plus a supported trip length). */
export interface FlexibleSearchQuery {
  origin: string;
  destination: string;
  /** 1-12. */
  month: number;
  duration: FlexDurationValue;
  party: PassengerParty;
  cabin: CabinValue;
  stops: StopsPreferenceValue;
  currency: string;
  market: string;
  includeAirlines?: string | null;
  excludeAirlines?: string | null;
}

/**
 * Request parameters, credentials excluded. Numbers stay numbers: the
 * canonical JSON encoding distinguishes `2` from `"2"`, and this object is
 * hashed into the cache key, so a coerced type would silently split the cache
 * from the rows the Python app wrote.
 */
export type ProviderParams = Record<string, string | number>;

/**
 * Segment and layover keys stay snake_case because these objects are stored
 * verbatim as JSON in `fare_observations.segments` / `.layovers`, alongside
 * rows the Python app already wrote. Renaming them here would make imported
 * history unreadable by the same rendering code.
 */
export interface OfferSegment {
  departure_id: string | null;
  departure_name: string | null;
  departure_time?: string | null;
  arrival_id: string | null;
  arrival_name: string | null;
  arrival_time?: string | null;
  airline: string | null;
  airline_code?: string | null;
  flight_number?: string | null;
  travel_class?: string | null;
  duration_minutes: number | null;
  airplane?: string | null;
  overnight?: boolean | null;
  cheapest_flight?: boolean;
}

export interface OfferLayover {
  id: string | null;
  name: string | null;
  duration_minutes: number | null;
  overnight: boolean | null;
}

/** One itinerary, normalized but never lossy about the provider's own value. */
export interface NormalizedOffer {
  /** The provider's reported price, in cents, on the basis `priceScope` names. */
  priceCents: number;
  currency: string;
  priceScope: PriceScopeValue;
  market: string;
  origin: string | null;
  destination: string | null;
  outboundDate: string | null;
  returnDate: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  airlines: string[];
  flightNumbers: string[];
  stops: number | null;
  durationMinutes: number | null;
  cabin: string | null;
  segments: OfferSegment[];
  layovers: OfferLayover[];
  bookingLink: string | null;
  searchLink: string | null;
}

/** Everything one provider call produced. */
export interface ProviderResult {
  endpoint: EndpointTypeValue;
  market: string;
  currency: string;
  queryFingerprint: string;
  offers: NormalizedOffer[];
  /** ISO-8601 UTC, as stored. */
  responseAt: string;
  /** Billable provider searches this result consumed (0 when served from cache). */
  requestCount: number;
  searchLink: string | null;
  outboundDate: string | null;
  returnDate: string | null;
  /** Sanitized, credential-free excerpt kept for debugging. */
  rawExcerpt: Record<string, unknown>;
  fromCache: boolean;
}

/** Provider-reported quota. Fetching this must not consume a search. */
export interface AccountStatus {
  planName: string | null;
  searchesPerMonth: number | null;
  searchesLeft: number | null;
  thisMonthUsage: number | null;
  rateLimitPerHour: number | null;
  accountEmailMasked: string | null;
  fetchedAt: string;
}

export interface ParsePayloadOptions {
  flexible: boolean;
  market: string;
  currency: string;
  queryFingerprint: string;
  outboundDate?: string | null;
  returnDate?: string | null;
}

export interface FareProvider {
  readonly name: string;
  /** How this provider's prices should be read (party total vs each). */
  readonly priceScope: PriceScopeValue;
  readonly exactEndpoint: EndpointTypeValue;
  readonly flexibleEndpoint: EndpointTypeValue;
  /** Maximum HTTP attempts one logical search can consume. Defaults to one. */
  readonly maxRequestCount?: number;

  /** True when credentials are present. Never returns the credential. */
  isConfigured(): boolean;
  /** True when this provider can answer route-specific flexible searches. */
  supportsFlexible(): boolean;

  buildExactParams(query: ExactSearchQuery): ProviderParams;
  buildFlexibleParams(query: FlexibleSearchQuery): ProviderParams;

  searchExact(query: ExactSearchQuery): Promise<ProviderResult>;
  searchFlexible(query: FlexibleSearchQuery): Promise<ProviderResult>;

  /**
   * Read a stored response body back into a result, so a cached payload can be
   * replayed without spending a search. It therefore has to accept exactly
   * what this provider's own search methods produced.
   */
  parsePayload(payload: unknown, options: ParsePayloadOptions): ProviderResult;

  accountStatus(): Promise<AccountStatus>;
}

/** Mask an account identifier for display. Never used on a token. */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at !== -1) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const head = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(3, local.length - head.length))}@${domain}`;
  }
  return `${value.slice(0, 2)}${"*".repeat(Math.max(3, value.length - 2))}`;
}
