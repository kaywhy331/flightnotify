/**
 * Flexible-window date-pair generation and deterministic fair ordering.
 *
 * Port of `flightnotify/domain/dates.py`. Dates are `YYYY-MM-DD` strings, which
 * is how D1 stores them; arithmetic goes through UTC epoch days so a local
 * timezone can never shift a departure date by one.
 */

/**
 * Hard ceiling on generated combinations. Above this the window is refused
 * with actionable guidance rather than quietly truncated -- a silently
 * shortened sweep would under-report coverage forever.
 */
// Keep one atomic D1 tracker/config/candidate batch comfortably below the
// Free-plan 1,000-statement ceiling (the batch also contains tracker/version
// metadata and market writes).
export const MAX_CANDIDATES = 500;

export interface DatePair {
  outbound: string;
  inbound: string;
  nights: number;
}

export class DateWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateWindowError";
  }
}

const DAY_MS = 86_400_000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toEpochDay(value: string): number {
  if (!DATE_ONLY_RE.test(value)) throw new DateWindowError(`Not a valid date: ${value}`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new DateWindowError(`Not a valid date: ${value}`);
  }
  return Math.round(ms / DAY_MS);
}

export function isValidDateOnly(value: string): boolean {
  try {
    toEpochDay(value);
    return true;
  } catch {
    return false;
  }
}

function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function addDaysTo(value: string, days: number): string {
  return fromEpochDay(toEpochDay(value) + days);
}

/**
 * Indices 0..n-1 ordered by recursive bisection: the middle of the range
 * first, then the middles of each half.
 *
 * Checking candidates in this order samples across the whole window early
 * instead of exhausting the earliest dates first, and it is fully
 * deterministic, so coverage survives a restart -- or, now, a Worker that is
 * torn down between Cron ticks.
 *
 * bisectionOrder(7) -> [3, 1, 5, 0, 2, 4, 6]
 */
export function bisectionOrder(n: number): number[] {
  if (n <= 0) return [];
  const order: number[] = [];
  const queue: [number, number][] = [[0, n - 1]];
  while (queue.length > 0) {
    const [lo, hi] = queue.shift()!;
    if (lo > hi) continue;
    const mid = Math.floor((lo + hi) / 2);
    order.push(mid);
    if (lo <= mid - 1) queue.push([lo, mid - 1]);
    if (mid + 1 <= hi) queue.push([mid + 1, hi]);
  }
  return order;
}

export interface GeneratePairsArgs {
  outboundStart: string;
  outboundEnd: string;
  returnStart?: string | null;
  returnEnd?: string | null;
  minNights?: number | null;
  maxNights?: number | null;
  /** Departures before this date are excluded (the operator's local today). */
  notBefore?: string | null;
  maxCandidates?: number;
}

/**
 * Build every valid round-trip date pair for a custom flexible window.
 *
 * Either a return window or a min/max trip length drives the return leg;
 * supplying both applies the nights range as an extra filter on the window.
 */
export function generatePairs(args: GeneratePairsArgs): DatePair[] {
  const {
    returnStart = null,
    returnEnd = null,
    minNights = null,
    maxNights = null,
    notBefore = null,
    maxCandidates = MAX_CANDIDATES,
  } = args;

  let startDay = toEpochDay(args.outboundStart);
  const endDay = toEpochDay(args.outboundEnd);

  if (endDay < startDay) {
    throw new DateWindowError("The outbound window ends before it starts.");
  }

  if (notBefore !== null) {
    startDay = Math.max(startDay, toEpochDay(notBefore));
    if (endDay < startDay) {
      throw new DateWindowError("The whole outbound window is in the past. Choose future dates.");
    }
  }

  if (returnStart === null && minNights === null) {
    throw new DateWindowError(
      "Provide either a return date window or a minimum and maximum trip length.",
    );
  }

  if (minNights !== null && maxNights !== null && maxNights < minNights) {
    throw new DateWindowError("Maximum trip length is shorter than the minimum.");
  }

  if (returnStart !== null && returnEnd !== null && toEpochDay(returnEnd) < toEpochDay(returnStart)) {
    throw new DateWindowError("The return window ends before it starts.");
  }

  const pairs: DatePair[] = [];
  for (let outboundDay = startDay; outboundDay <= endDay; outboundDay += 1) {
    let inboundDays: number[];
    if (returnStart !== null && returnEnd !== null) {
      const lo = Math.max(toEpochDay(returnStart), outboundDay + 1);
      const hi = toEpochDay(returnEnd);
      inboundDays = [];
      for (let d = lo; d <= hi; d += 1) inboundDays.push(d);
    } else {
      const lo = Math.max(minNights ?? 1, 1);
      const hi = maxNights ?? lo;
      inboundDays = [];
      for (let n = lo; n <= hi; n += 1) inboundDays.push(outboundDay + n);
    }

    for (const inboundDay of inboundDays) {
      const nights = inboundDay - outboundDay;
      if (nights < 1) continue;
      if (minNights !== null && nights < minNights) continue;
      if (maxNights !== null && nights > maxNights) continue;
      pairs.push({
        outbound: fromEpochDay(outboundDay),
        inbound: fromEpochDay(inboundDay),
        nights,
      });
      if (pairs.length > maxCandidates) {
        throw new DateWindowError(
          `This window produces more than ${maxCandidates} date combinations. ` +
            "Narrow the outbound window or tighten the trip length.",
        );
      }
    }
  }

  if (pairs.length === 0) {
    throw new DateWindowError(
      "No valid outbound/return combination exists for this window. " +
        "Check that returns can fall after departures and that the trip length fits " +
        "inside the return window.",
    );
  }

  pairs.sort((a, b) =>
    a.outbound === b.outbound ? a.inbound.localeCompare(b.inbound) : a.outbound.localeCompare(b.outbound),
  );
  return pairs;
}

/** Attach the deterministic fair queue position to each pair. */
export function orderedPairs(pairs: DatePair[]): DatePair[] {
  return bisectionOrder(pairs.length).map((index) => pairs[index]!);
}

/**
 * Validate a flexible-preset month against the provider's 6-month horizon.
 *
 * Google Travel Explore accepts month 1-12 and only looks ahead six months, so
 * a month outside that horizon is rejected here rather than producing an empty
 * provider response that would look like "no fares found".
 */
export function flexiblePresetMonth(
  targetMonth: number,
  targetYear: number,
  today: string,
): { month: number; year: number } {
  if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
    throw new DateWindowError("Choose a month between January and December.");
  }
  if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
    throw new DateWindowError("Choose a valid year.");
  }
  const [todayYear, todayMonth] = today.split("-").map(Number) as [number, number];
  const monthsAhead = (targetYear - todayYear) * 12 + (targetMonth - todayMonth);
  if (monthsAhead < 0) throw new DateWindowError("That month is already in the past.");
  if (monthsAhead > 6) {
    throw new DateWindowError(
      "Google Travel Explore only supports flexible months within the next 6 months. " +
        "Pick a nearer month, or use a custom flexible window.",
    );
  }
  return { month: targetMonth, year: targetYear };
}
