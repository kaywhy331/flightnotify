/**
 * SerpApi adapter: request construction, response normalization, error
 * classification.
 *
 * Every test drives the adapter through a fake fetch and the recorded fixtures
 * in `tests/fixtures/`, which are the same payloads the Python suite asserts
 * on. The global `fetch` is stubbed with a thrower for the whole file: a real
 * SerpApi call would spend the owner's monthly quota, so a test that forgets
 * its stub must fail loudly rather than quietly bill someone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import accountFixture from "../../tests/fixtures/serpapi_account.json";
import flightsFixture from "../../tests/fixtures/google_flights_round_trip.json";
import exploreFixture from "../../tests/fixtures/google_travel_explore_route.json";
import noResultsFixture from "../../tests/fixtures/google_flights_no_results.json";

import {
  Cabin,
  EndpointType,
  ErrorCategory,
  FlexDuration,
  PriceScopeLabel,
  StopsPreference,
} from "../src/domain/enums.js";
import { queryFingerprint } from "../src/domain/fingerprints.js";
import type { Config } from "../src/env.js";
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
} from "../src/providers/errors.js";
import {
  SerpApiProvider,
  parseGoogleFlights,
  parseGoogleTravelExplore,
  priceCentsFrom,
  sanitizeExcerpt,
  validateParty,
} from "../src/providers/serpapi.js";
import {
  makeParty,
  maskIdentifier,
  payingTravelers,
  type ExactSearchQuery,
  type FlexibleSearchQuery,
} from "../src/providers/types.js";

const API_KEY = "test-key-not-real-0123456789";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    appTimezone: "UTC",
    defaultCurrency: "USD",
    defaultMarket: "us",
    serpapiApiKey: API_KEY,
    serpapiBaseUrl: "https://serpapi.invalid",
    priceScope: PriceScopeLabel.PARTY_TOTAL,
    monthlySearchBudget: 250,
    reserveSearches: 10,
    reservePercent: 4,
    hourlySearchLimit: 50,
    queryCacheTtlSeconds: 900,
    telegramBotToken: "",
    telegramChatId: "",
    telegramBaseUrl: "https://api.telegram.invalid",
    authPasswordHash: "argon-hash",
    sessionSecret: "s".repeat(32),
    schedulerEnabled: false,
    maxTrackersPerTick: 2,
    maxQueriesPerTick: 3,
    schedulerLeaseTtlSeconds: 300,
    offlineMode: false,
    ...overrides,
  };
}

interface FakeResponse {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/** Replays `responses` in order; the last one repeats. Records every URL. */
function fakeFetch(responses: FakeResponse[], calls: URL[] = []): typeof fetch {
  let index = 0;
  return async (input: RequestInfo | URL): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(new URL(href));
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  };
}

function provider(
  responses: FakeResponse[],
  calls: URL[] = [],
  config: Partial<Config> = {},
): SerpApiProvider {
  return new SerpApiProvider(makeConfig(config), {
    fetch: fakeFetch(responses, calls),
    timeoutMs: 1_000,
    sleep: async () => {},
    random: () => 0,
  });
}

function exactQuery(overrides: Partial<ExactSearchQuery> = {}): ExactSearchQuery {
  return {
    origin: "SFO",
    destination: "NRT",
    outboundDate: "2026-10-12",
    returnDate: "2026-10-20",
    party: makeParty({ adults: 2 }),
    cabin: Cabin.ECONOMY,
    stops: StopsPreference.ANY,
    currency: "USD",
    market: "us",
    ...overrides,
  };
}

function flexibleQuery(overrides: Partial<FlexibleSearchQuery> = {}): FlexibleSearchQuery {
  return {
    origin: "SFO",
    destination: "NRT",
    month: 11,
    duration: FlexDuration.TWO_WEEKS,
    party: makeParty({ adults: 2 }),
    cabin: Cabin.ECONOMY,
    stops: StopsPreference.ANY,
    currency: "USD",
    market: "us",
    ...overrides,
  };
}

const EXACT_PARSE = {
  market: "us",
  currency: "USD",
  queryFingerprint: "fp",
  priceScope: PriceScopeLabel.PARTY_TOTAL,
  outboundDate: "2026-10-12",
  returnDate: "2026-10-20",
};
const FLEX_PARSE = {
  market: "us",
  currency: "USD",
  queryFingerprint: "fp",
  priceScope: PriceScopeLabel.PARTY_TOTAL,
};

beforeEach(() => {
  vi.stubGlobal("fetch", ((): never => {
    throw new Error("a test tried to reach the network; SerpApi quota is real money");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------- request shape
describe("request parameters", () => {
  it("matches the documented SerpApi encoding", () => {
    const params = provider([{ body: {} }]).buildExactParams(
      exactQuery({ cabin: Cabin.BUSINESS, stops: StopsPreference.NONSTOP }),
    );
    expect(params["engine"]).toBe("google_flights");
    expect(params["type"]).toBe(1); // round trip
    expect(params["travel_class"]).toBe(3); // business
    expect(params["stops"]).toBe(1); // nonstop only
    expect(params["departure_id"]).toBe("SFO");
    expect(params["arrival_id"]).toBe("NRT");
    expect(params["outbound_date"]).toBe("2026-10-12");
    expect(params["return_date"]).toBe("2026-10-20");
    expect(params["adults"]).toBe(2);
    expect(params["gl"]).toBe("us");
    expect(params["currency"]).toBe("USD");
    // Credentials are added by the transport layer, never by the builder.
    expect(params).not.toHaveProperty("api_key");
  });

  it("omits the stops filter when any number of stops is acceptable", () => {
    const params = provider([{ body: {} }]).buildExactParams(exactQuery());
    expect(params).not.toHaveProperty("stops");
  });

  it("never sends include and exclude airlines together", () => {
    const params = provider([{ body: {} }]).buildExactParams(
      exactQuery({ includeAirlines: "NH,UA", excludeAirlines: "F9" }),
    );
    expect(params["include_airlines"]).toBe("NH,UA");
    expect(params).not.toHaveProperty("exclude_airlines");
  });

  it("builds the flexible search parameters", () => {
    const params = provider([{ body: {} }]).buildFlexibleParams(flexibleQuery());
    expect(params["engine"]).toBe("google_travel_explore");
    expect(params["month"]).toBe(11);
    expect(params["travel_duration"]).toBe(3); // 2 weeks
    expect(params["travel_mode"]).toBe(1); // flights only
    expect(params["arrival_id"]).toBe("NRT");
  });

  it("keeps numeric parameters numeric, so the cache key matches the Python rows", async () => {
    const params = provider([{ body: {} }]).buildExactParams(exactQuery());
    expect(typeof params["adults"]).toBe("number");
    await expect(queryFingerprint("google_flights", params)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

// -------------------------------------------------------------------- money
describe("price conversion", () => {
  it("converts a fractional provider price to exact cents", () => {
    expect(priceCentsFrom(1042.5)).toBe(104250);
    expect(priceCentsFrom(1962.0)).toBe(196200);
    expect(priceCentsFrom(1248)).toBe(124800);
    expect(priceCentsFrom(0.07)).toBe(7);
    expect(priceCentsFrom("1,248.50")).toBe(124850);
  });

  it("rejects prices that cannot be tracked instead of storing a zero", () => {
    expect(priceCentsFrom(null)).toBeNull();
    expect(priceCentsFrom(undefined)).toBeNull();
    expect(priceCentsFrom(0)).toBeNull();
    expect(priceCentsFrom(-5)).toBeNull();
    expect(priceCentsFrom(true)).toBeNull();
    expect(priceCentsFrom("free")).toBeNull();
  });

  it("carries a fractional price through parsing without float drift", () => {
    const result = parseGoogleFlights(
      { other_flights: [{ flights: [], price: 1042.5 }] },
      { ...EXACT_PARSE, outboundDate: null, returnDate: null },
    );
    expect(result.offers[0]!.priceCents).toBe(104250);
  });
});

// ---------------------------------------------------------------- exact mode
describe("google flights parsing", () => {
  it("normalizes the recorded round-trip response", () => {
    const result = parseGoogleFlights(flightsFixture, EXACT_PARSE);
    expect(result.endpoint).toBe(EndpointType.GOOGLE_FLIGHTS);
    expect(result.offers).toHaveLength(2);
    expect(result.requestCount).toBe(1);
    // Taken from the payload's own processed_at, not from the clock.
    expect(result.responseAt).toBe("2026-08-01T09:15:05.000Z");

    const cheapest = [...result.offers].sort((a, b) => a.priceCents - b.priceCents)[0]!;
    expect(cheapest.priceCents).toBe(124800);
    expect(cheapest.currency).toBe("USD");
    expect(cheapest.origin).toBe("SFO");
    expect(cheapest.destination).toBe("NRT");
    expect(cheapest.stops).toBe(0);
    expect(cheapest.airlines).toEqual(["ANA"]);
    expect(cheapest.flightNumbers).toEqual(["NH 8"]);
    expect(cheapest.cabin).toBe("Economy");
    expect(cheapest.durationMinutes).toBe(655);
    expect(cheapest.outboundDate).toBe("2026-10-12");
    expect(cheapest.returnDate).toBe("2026-10-20");
    expect(cheapest.departureTime).toBe("2026-10-12 11:05");
    expect(cheapest.arrivalTime).toBe("2026-10-13 14:40");
    expect(cheapest.searchLink?.startsWith("https://www.google.com/travel/flights")).toBe(true);
    // A booking link needs a second billable search, so none is invented.
    expect(cheapest.bookingLink).toBeNull();
    expect(cheapest.segments[0]!.airplane).toBe("Boeing 787");
    expect(cheapest.segments[0]!.overnight).toBe(true);
  });

  it("counts layovers as stops on a connecting itinerary", () => {
    const result = parseGoogleFlights(flightsFixture, EXACT_PARSE);
    const connecting = [...result.offers].sort((a, b) => b.priceCents - a.priceCents)[0]!;
    expect(connecting.priceCents).toBe(139000);
    expect(connecting.stops).toBe(1);
    expect(connecting.flightNumbers).toEqual(["AS 1234", "JL 69"]);
    expect(connecting.airlines).toEqual(["Alaska", "Japan Airlines"]);
    expect(connecting.layovers[0]!.id).toBe("SEA");
    expect(connecting.layovers[0]!.duration_minutes).toBe(140);
  });

  it("skips itineraries without a usable price", () => {
    const result = parseGoogleFlights(
      { other_flights: [{ flights: [], price: null }, { flights: [], price: 500 }] },
      { ...EXACT_PARSE, outboundDate: null, returnDate: null },
    );
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]!.priceCents).toBe(50000);
  });

  it("prefers the caller's dates over the response echo", () => {
    const result = parseGoogleFlights(flightsFixture, {
      ...EXACT_PARSE,
      outboundDate: "2026-10-13",
      returnDate: "2026-10-21",
    });
    expect(result.outboundDate).toBe("2026-10-13");
    expect(result.returnDate).toBe("2026-10-21");
  });

  it("rejects a payload that is not a JSON object", () => {
    expect(() => parseGoogleFlights([1, 2, 3], EXACT_PARSE)).toThrow(
      ProviderMalformedResponseError,
    );
  });
});

// ------------------------------------------------------------- flexible mode
describe("travel explore parsing", () => {
  it("preserves the dates the provider chose", () => {
    const result = parseGoogleTravelExplore(exploreFixture, FLEX_PARSE);
    expect(result.endpoint).toBe(EndpointType.GOOGLE_TRAVEL_EXPLORE);
    expect(result.outboundDate).toBe("2026-11-07");
    expect(result.returnDate).toBe("2026-11-14");
    expect(result.searchLink).toBe(exploreFixture.google_flights_link);
    expect(result.offers.map((o) => o.priceCents)).toEqual([98600, 110400]);
    expect(result.offers[0]!.outboundDate).toBe("2026-11-07");
    expect(result.offers[0]!.returnDate).toBe("2026-11-14");
    expect(result.offers[0]!.stops).toBe(0);
    expect(result.offers[0]!.airlines).toEqual(["ZIPAIR"]);
    expect(result.offers[0]!.segments[0]!.cheapest_flight).toBe(true);
    expect(result.offers[1]!.segments[0]!.cheapest_flight).toBe(false);
  });

  it("rejects a destination-suggestion response", () => {
    expect(() =>
      parseGoogleTravelExplore({ destinations: [{ name: "Tokyo" }] }, FLEX_PARSE),
    ).toThrow(ProviderMalformedResponseError);
  });

  it("runs a flexible search end to end", async () => {
    const calls: URL[] = [];
    const result = await provider([{ body: exploreFixture }], calls).searchFlexible(
      flexibleQuery(),
    );
    expect(calls[0]!.searchParams.get("engine")).toBe("google_travel_explore");
    expect(result.offers).toHaveLength(2);
    expect(result.endpoint).toBe(EndpointType.GOOGLE_TRAVEL_EXPLORE);
  });
});

// --------------------------------------------------------------- price scope
describe("price scope", () => {
  it("reports the raw provider price plus the configured scope label", async () => {
    const result = await provider([{ body: flightsFixture }]).searchExact(
      exactQuery({ party: makeParty({ adults: 4 }) }),
    );
    for (const offer of result.offers) {
      expect(offer.priceScope).toBe(PriceScopeLabel.PARTY_TOTAL);
    }
    // The party has four paying travelers; the adapter must not divide by them.
    expect(payingTravelers(makeParty({ adults: 4 }))).toBe(4);
    expect(result.offers.map((o) => o.priceCents)).toEqual([124800, 139000]);
  });

  it("carries an unknown scope through untouched rather than guessing a basis", () => {
    const result = parseGoogleFlights(flightsFixture, {
      ...EXACT_PARSE,
      priceScope: PriceScopeLabel.UNKNOWN,
    });
    expect(result.offers[0]!.priceScope).toBe(PriceScopeLabel.UNKNOWN);
    expect(result.offers[0]!.priceCents).toBe(124800);
  });
});

// -------------------------------------------------------------------- errors
describe("error classification", () => {
  it("treats no results as a successful empty run", async () => {
    const result = await provider([{ body: noResultsFixture }]).searchExact(exactQuery());
    expect(result.offers).toEqual([]);
    expect(result.requestCount).toBe(1); // counted conservatively
    expect(result.outboundDate).toBe("2026-10-12");
  });

  it("raises an auth error for an invalid key", async () => {
    const call = provider([{ body: { error: "Invalid API key." }, status: 401 }]).searchExact(
      exactQuery(),
    );
    await expect(call).rejects.toBeInstanceOf(ProviderAuthError);
    await call.catch((error: ProviderAuthError) => {
      expect(error.category).toBe(ErrorCategory.INVALID_CREDENTIALS);
      expect(error.guidance().toLowerCase()).toContain("stored history is unchanged");
    });
  });

  it("surfaces a rate limit with its retry-after", async () => {
    const call = provider([
      { body: { error: "Too many requests" }, status: 429, headers: { "Retry-After": "12" } },
    ]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderRateLimitError);
    await call.catch((error: ProviderRateLimitError) => {
      expect(error.retryAfterSeconds).toBe(12);
      expect(error.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(error.retryable).toBe(true);
    });
  });

  it("distinguishes an exhausted quota from a rate limit", async () => {
    const call = provider([
      { body: { error: "Your account has run out of searches." }, status: 429 },
    ]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
    await call.catch((error: ProviderQuotaExhaustedError) => {
      expect(error.category).toBe(ErrorCategory.QUOTA_EXHAUSTED);
    });
  });

  it("makes an unsupported query actionable", async () => {
    const call = provider([
      { body: { error: "departure_id is not a valid airport" } },
    ]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderUnsupportedQueryError);
    await call.catch((error: ProviderUnsupportedQueryError) => {
      expect(error.category).toBe(ErrorCategory.UNSUPPORTED_QUERY);
      expect(error.guidance()).toContain("history is unchanged");
      expect(error.guidance()).toContain("departure_id is not a valid airport");
    });
  });

  it("reports an error status carried in the search metadata", async () => {
    const call = provider([
      { body: { search_metadata: { status: "Error", error: "wrong request" } } },
    ]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderUnsupportedQueryError);
  });

  it("treats an empty body as malformed", async () => {
    const call = provider([{ body: {} }]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderMalformedResponseError);
    await call.catch((error: ProviderMalformedResponseError) => {
      expect(error.category).toBe(ErrorCategory.MALFORMED_RESPONSE);
    });
  });

  it("classifies a bare HTTP failure with no message as a provider error", async () => {
    const call = provider([{ body: {}, status: 400 }]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderError);
    await call.catch((error: ProviderError) => {
      expect(error.category).toBe(ErrorCategory.PROVIDER_ERROR);
    });
  });

  it("retries a transient server error, then succeeds", async () => {
    const calls: URL[] = [];
    const result = await provider(
      [{ body: { error: "bad gateway" }, status: 502 }, { body: flightsFixture }],
      calls,
    ).searchExact(exactQuery());
    expect(calls).toHaveLength(2);
    expect(result.offers).toHaveLength(2);
  });

  it("gives up after the attempt limit and reports a network error", async () => {
    const calls: URL[] = [];
    const failing = new SerpApiProvider(makeConfig(), {
      fetch: fakeFetch([{ body: {}, status: 503 }], calls),
      sleep: async () => {},
      random: () => 0,
      maxAttempts: 3,
    });
    const call = failing.searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderNetworkError);
    await call.catch((error: ProviderNetworkError) => {
      expect(error.category).toBe(ErrorCategory.NETWORK);
    });
    expect(calls).toHaveLength(3);
  });

  it("maps an aborted request to a timeout", async () => {
    const timingOut = new SerpApiProvider(makeConfig(), {
      fetch: async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
      sleep: async () => {},
      maxAttempts: 1,
    });
    const call = timingOut.searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderTimeoutError);
    await call.catch((error: ProviderTimeoutError) => {
      expect(error.category).toBe(ErrorCategory.TIMEOUT);
      expect(error.guidance()).toContain("timed out");
    });
  });

  it("reports only the error type when the transport itself fails", async () => {
    const broken = new SerpApiProvider(makeConfig(), {
      // A real fetch failure quotes the request URL, which carries the key.
      fetch: async () => {
        throw new TypeError(`fetch failed for https://serpapi.invalid/search.json?api_key=${API_KEY}`);
      },
      sleep: async () => {},
      maxAttempts: 1,
    });
    const call = broken.searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderNetworkError);
    await call.catch((error: ProviderNetworkError) => {
      expect(error.message).toBe("SerpApi request failed: TypeError");
      expect(error.message).not.toContain(API_KEY);
      expect(error.guidance()).not.toContain(API_KEY);
    });
  });

  it("never calls the provider without credentials", async () => {
    const calls: URL[] = [];
    const unconfigured = new SerpApiProvider(makeConfig({ serpapiApiKey: "" }), {
      fetch: fakeFetch([{ body: flightsFixture }], calls),
    });
    expect(unconfigured.isConfigured()).toBe(false);
    const call = unconfigured.searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderMissingCredentialsError);
    await call.catch((error: ProviderMissingCredentialsError) => {
      expect(error.category).toBe(ErrorCategory.MISSING_CREDENTIALS);
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses to issue a request in offline mode", async () => {
    const calls: URL[] = [];
    const offline = new SerpApiProvider(makeConfig({ offlineMode: true }), {
      fetch: fakeFetch([{ body: flightsFixture }], calls),
      sleep: async () => {},
      maxAttempts: 1,
    });
    await expect(offline.searchExact(exactQuery())).rejects.toBeInstanceOf(ProviderNetworkError);
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- secrets
describe("credential containment", () => {
  it("keeps the key out of every error's guidance", async () => {
    const echoed = `Invalid value for api_key=${API_KEY} in request`;
    const call = provider([{ body: { error: echoed } }]).searchExact(exactQuery());
    await expect(call).rejects.toBeInstanceOf(ProviderUnsupportedQueryError);
    await call.catch((error: ProviderUnsupportedQueryError) => {
      expect(error.guidance()).not.toContain(API_KEY);
      expect(error.message).not.toContain(API_KEY);
      expect(error.guidance()).toContain("[redacted]");
    });

    const constructed: ProviderError[] = [
      new ProviderError("boom"),
      new ProviderMissingCredentialsError(),
      new ProviderAuthError("bad key"),
      new ProviderRateLimitError("slow down", 5),
      new ProviderQuotaExhaustedError("empty"),
      new ProviderTimeoutError("slow"),
      new ProviderNetworkError("unreachable"),
      new ProviderMalformedResponseError("garbled"),
      new ProviderUnsupportedQueryError("nope"),
    ];
    for (const error of constructed) {
      expect(error.guidance()).not.toContain(API_KEY);
      expect(error.guidance().length).toBeGreaterThan(0);
    }
  });

  it("keeps the key out of the query fingerprint and the stored excerpt", async () => {
    const calls: URL[] = [];
    const result = await provider([{ body: flightsFixture }], calls).searchExact(exactQuery());

    // The key travels in the request and nowhere else.
    expect(calls[0]!.searchParams.get("api_key")).toBe(API_KEY);
    expect(calls[0]!.pathname).toBe("/search.json");

    expect(result.queryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.queryFingerprint).not.toContain(API_KEY);
    expect(JSON.stringify(result.rawExcerpt)).not.toContain(API_KEY);

    // Adding the credential to the parameters cannot change the cache key.
    const params = provider([{ body: {} }]).buildExactParams(exactQuery());
    const withKey = await queryFingerprint("google_flights", {
      ...params,
      api_key: API_KEY,
      output: "json",
    });
    expect(withKey).toBe(result.queryFingerprint);
  });

  it("drops credentials and bulk from the stored excerpt", () => {
    const excerpt = sanitizeExcerpt(flightsFixture);
    expect(JSON.stringify(excerpt)).not.toContain("api_key");
    expect(excerpt).not.toHaveProperty("best_flights");
    const metadata = excerpt["search_metadata"] as Record<string, unknown>;
    expect(metadata["id"]).toBe(flightsFixture.search_metadata.id);
    expect(excerpt["price_insights"]).toEqual({
      lowest_price: 1248,
      price_level: "typical",
      typical_price_range: [1180, 1520],
    });
  });

  it("masks an account identifier instead of echoing it", () => {
    expect(maskIdentifier("operator@example.invalid")).toBe("op******@example.invalid");
    expect(maskIdentifier("ab")).toBe("ab***");
    expect(maskIdentifier(null)).toBeNull();
  });
});

// ------------------------------------------------------------------- account
describe("account status", () => {
  it("parses the quota response without spending a search", async () => {
    const calls: URL[] = [];
    const status = await provider([{ body: accountFixture }], calls).accountStatus();
    expect(calls[0]!.pathname).toBe("/account.json");
    // No engine parameter: this is not a fare search.
    expect(calls[0]!.searchParams.get("engine")).toBeNull();

    expect(status.searchesPerMonth).toBe(250);
    expect(status.searchesLeft).toBe(198);
    expect(status.thisMonthUsage).toBe(52);
    expect(status.planName).toBe("Free Plan");
    expect(status.rateLimitPerHour).toBe(50);
    expect(status.accountEmailMasked).not.toBe(accountFixture.account_email);
    expect(status.accountEmailMasked?.endsWith("@example.invalid")).toBe(true);
  });
});

// ---------------------------------------------------------------- global seam
describe("fetch resolution", () => {
  it("uses the global fetch when none is injected, resolved per call", async () => {
    const calls: URL[] = [];
    const live = new SerpApiProvider(makeConfig(), { timeoutMs: 1_000 });
    vi.stubGlobal("fetch", fakeFetch([{ body: flightsFixture }], calls));
    const result = await live.searchExact(exactQuery());
    expect(calls).toHaveLength(1);
    expect(result.offers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- validation
describe("party validation", () => {
  const cases: Array<[[number, number, number, number], boolean]> = [
    [[1, 0, 0, 0], false],
    [[0, 1, 0, 0], true], // no adult
    [[5, 5, 0, 0], true], // over the 9-passenger cap
    [[1, 0, 0, 2], true], // more lap infants than adults
    [[2, 2, 1, 1], false],
  ];
  for (const [party, expectProblem] of cases) {
    it(`${party.join("/")} ${expectProblem ? "has" : "has no"} problems`, () => {
      expect(validateParty(...party).length > 0).toBe(expectProblem);
    });
  }
});
