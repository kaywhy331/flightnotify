/**
 * Tracker form parsing, validation and budget estimation.
 *
 * Port of `flightnotify/forms.py` plus the budget preview the Python form
 * rendered. Kept out of the router so the same parse can serve three callers
 * that must not disagree: create, edit, and the live `/api/estimate` preview.
 *
 * Two invariants matter beyond ordinary validation:
 *
 *   - Fields belonging to an inactive date mode are written back as NULL.
 *     They are part of the comparison payload, so a stale `flex_month` left on
 *     an exact-date tracker would change its series fingerprint and orphan its
 *     price history. This mirrors what the Python form did.
 *   - The date pairs a custom window expands to are generated here and
 *     persisted, not recomputed at scan time, so the sweep is reproducible and
 *     its progress survives a Worker being torn down between Cron ticks.
 */

import {
  Cabin,
  DateMode,
  FlexDuration,
  StopsPreference,
  ThresholdBasis,
  type DateModeValue,
} from "../domain/enums.js";
import {
  DateWindowError,
  flexiblePresetMonth,
  generatePairs,
  isValidDateOnly,
  orderedPairs,
  type DatePair,
} from "../domain/dates.js";
import { centsFromDecimalString } from "../domain/money.js";
import {
  SCHEDULE_CHOICES,
  assess,
  estimate,
  type BudgetVerdict,
  type PlanEstimate,
} from "../services/planner.js";
import type { QuotaSnapshot } from "../services/quota.js";
import { nowIso } from "../time.js";

export interface ParsedTrackerForm {
  /** Raw values, echoed back so a rejected form keeps what was typed. */
  values: Record<string, string>;
  errors: Record<string, string>;
  /** Column values ready for INSERT/UPDATE. Empty when there are errors. */
  fields: Record<string, unknown>;
  markets: string[];
  /** Generated pairs for a custom window; empty for the other modes. */
  candidates: DatePair[];
  dateMode: DateModeValue;
  candidatesPerRun: number;
  checkIntervalMinutes: number;
  sampledModeAck: boolean;
}

const VALUE_KEYS = [
  "name",
  "origin",
  "destination",
  "adults",
  "children",
  "infants_in_seat",
  "infants_on_lap",
  "cabin",
  "stops",
  "include_airlines",
  "exclude_airlines",
  "currency",
  "date_mode",
  "outbound_date",
  "return_date",
  "flex_month",
  "flex_year",
  "flex_duration",
  "window_outbound_start",
  "window_outbound_end",
  "window_return_start",
  "window_return_end",
  "min_nights",
  "max_nights",
  "threshold_amount",
  "threshold_basis",
  "cooldown_minutes",
  "check_interval_minutes",
  "candidates_per_run",
  "min_drop_absolute",
  "min_drop_percent",
] as const;

const IATA_RE = /^[A-Z]{3}$/;
const MARKET_RE = /^[a-z]{2}$/;
export const AVAILABLE_MARKETS = ["us", "gb", "ca", "au", "de", "jp"] as const;
const AIRLINES_RE = /^[A-Z0-9]{2}(,[A-Z0-9]{2})*$/;
const MAX_MARKETS = 4;
const MAX_CANDIDATES_PER_RUN = 10;
const ALLOWED_INTERVALS = new Set(SCHEDULE_CHOICES.map(([minutes]) => minutes));

function intOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

/**
 * Parse and validate a submitted tracker form.
 *
 * `today` is the operator's local date, so "not in the past" means what it
 * means to them rather than to UTC.
 */
export function parseTrackerForm(
  form: FormData,
  options: { defaultMarket: string; today: string },
): ParsedTrackerForm {
  const get = (key: string): string => {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const values: Record<string, string> = {};
  for (const key of VALUE_KEYS) values[key] = get(key);
  values["alert_on_threshold"] = form.get("alert_on_threshold") ? "on" : "";
  values["alert_on_new_low"] = form.get("alert_on_new_low") ? "on" : "";
  values["sampled_mode_ack"] = form.get("sampled_mode_ack") ? "on" : "";

  const errors: Record<string, string> = {};

  // --- markets ----------------------------------------------------------
  const rawMarkets = form
    .getAll("markets")
    .map((market) => (typeof market === "string" ? market.trim().toLowerCase() : ""))
    .filter((m) => m !== "");
  const markets = [...new Set(rawMarkets)];
  const supportedMarkets = new Set<string>([...AVAILABLE_MARKETS, options.defaultMarket]);
  if (
    markets.some((market) => !MARKET_RE.test(market) || !supportedMarkets.has(market))
  ) {
    errors["markets"] = "Choose only one of the offered country markets.";
  } else if (markets.length > MAX_MARKETS) {
    errors["markets"] = `Select at most ${MAX_MARKETS} country markets; each costs a provider search.`;
  }
  const effectiveMarkets =
    markets.length > 0 &&
    markets.every((market) => MARKET_RE.test(market) && supportedMarkets.has(market))
      ? markets
      : [options.defaultMarket];
  values["markets"] = effectiveMarkets.join(",");

  // --- identity and route ------------------------------------------------
  const name = values["name"]!;
  if (name === "") errors["name"] = "Give the tracker a name.";
  else if (name.length > 120) errors["name"] = "Keep the name under 120 characters.";

  const origin = values["origin"]!.toUpperCase();
  const destination = values["destination"]!.toUpperCase();
  if (!IATA_RE.test(origin)) errors["origin"] = "Use a three-letter IATA airport code.";
  if (!IATA_RE.test(destination)) errors["destination"] = "Use a three-letter IATA airport code.";
  if (origin !== "" && origin === destination) {
    errors["destination"] = "Origin and destination must differ.";
  }

  // --- passengers --------------------------------------------------------
  const adults = intOr(values["adults"] || "1", -1);
  const children = intOr(values["children"] || "0", -1);
  const infantsInSeat = intOr(values["infants_in_seat"] || "0", -1);
  const infantsOnLap = intOr(values["infants_on_lap"] || "0", -1);
  if (adults < 1 || adults > 9) errors["adults"] = "Between 1 and 9 adults.";
  if (children < 0 || children > 8) errors["children"] = "Between 0 and 8 children.";
  if (infantsInSeat < 0) errors["infants_in_seat"] = "Cannot be negative.";
  if (infantsOnLap < 0) errors["infants_on_lap"] = "Cannot be negative.";
  if (infantsOnLap > adults) {
    // One lap infant needs one adult lap.
    errors["infants_on_lap"] = "There must be at least one adult per lap infant.";
  }
  const passengerTotal = adults + children + infantsInSeat + infantsOnLap;
  if (passengerTotal > 9) {
    errors["adults"] = `Google Flights allows at most 9 passengers; this tracker has ${passengerTotal}.`;
  }

  const cabin = values["cabin"] || Cabin.ECONOMY;
  if (!Object.values(Cabin).includes(cabin as (typeof Cabin)[keyof typeof Cabin])) {
    errors["cabin"] = "Choose a supported cabin.";
  }
  const stops = values["stops"] || StopsPreference.ANY;
  if (!Object.values(StopsPreference).includes(stops as (typeof StopsPreference)[keyof typeof StopsPreference])) {
    errors["stops"] = "Choose a supported stops preference.";
  }
  const includeAirlines = values["include_airlines"]!.toUpperCase().replace(/\s+/g, "");
  const excludeAirlines = values["exclude_airlines"]!.toUpperCase().replace(/\s+/g, "");
  values["include_airlines"] = includeAirlines;
  values["exclude_airlines"] = excludeAirlines;
  if (includeAirlines && !AIRLINES_RE.test(includeAirlines)) {
    errors["include_airlines"] = "Use comma-separated 2-character airline codes, for example UA,NH.";
  }
  if (excludeAirlines && !AIRLINES_RE.test(excludeAirlines)) {
    errors["exclude_airlines"] = "Use comma-separated 2-character airline codes, for example UA,NH.";
  }
  if (includeAirlines && excludeAirlines) {
    errors["exclude_airlines"] = "Choose included airlines or excluded airlines, not both.";
  }

  // --- comparison --------------------------------------------------------
  let thresholdCents = 0;
  try {
    thresholdCents = centsFromDecimalString(values["threshold_amount"]!);
    if (thresholdCents <= 0) errors["threshold_amount"] = "Enter an amount above zero.";
  } catch {
    errors["threshold_amount"] = "Enter an amount such as 1300 or 1300.50.";
  }

  let minDropAbsolute: number | null = null;
  if (values["min_drop_absolute"] !== "") {
    try {
      minDropAbsolute = centsFromDecimalString(values["min_drop_absolute"]!);
      if (minDropAbsolute < 0) errors["min_drop_absolute"] = "Cannot be negative.";
    } catch {
      errors["min_drop_absolute"] = "Enter an amount such as 50.";
    }
  }

  let minDropPercentBp: number | null = null;
  if (values["min_drop_percent"] !== "") {
    try {
      minDropPercentBp = centsFromDecimalString(values["min_drop_percent"]!);
      if (minDropPercentBp < 0 || minDropPercentBp > 10_000) {
        errors["min_drop_percent"] = "Enter a percentage between 0 and 100.";
      }
    } catch {
      errors["min_drop_percent"] = "Enter a percentage such as 5.";
    }
  }

  const currency = (values["currency"] || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors["currency"] = "Use a three-letter currency code.";

  // --- scheduling --------------------------------------------------------
  const checkIntervalMinutes = intOr(values["check_interval_minutes"] || "720", -1);
  if (!ALLOWED_INTERVALS.has(checkIntervalMinutes)) {
    errors["check_interval_minutes"] = "Choose one of the offered check frequencies.";
  }
  const cooldownMinutes = intOr(values["cooldown_minutes"] || "360", -1);
  if (cooldownMinutes < 0) errors["cooldown_minutes"] = "Cannot be negative.";
  const candidatesPerRun = intOr(values["candidates_per_run"] || "1", -1);
  if (candidatesPerRun < 1 || candidatesPerRun > MAX_CANDIDATES_PER_RUN) {
    errors["candidates_per_run"] =
      `Check between 1 and ${MAX_CANDIDATES_PER_RUN} date combinations per run.`;
  }

  // --- dates -------------------------------------------------------------
  const dateMode = (values["date_mode"] || DateMode.EXACT) as DateModeValue;
  if (
    dateMode !== DateMode.EXACT &&
    dateMode !== DateMode.FLEXIBLE_PRESET &&
    dateMode !== DateMode.CUSTOM_WINDOW
  ) {
    errors["date_mode"] = "Choose how the dates should be searched.";
  }

  // Every mode writes the full set; the inactive ones are NULL so they cannot
  // linger in the comparison fingerprint.
  const dateFields: Record<string, unknown> = {
    outbound_date: null,
    return_date: null,
    flex_month: null,
    flex_year: null,
    flex_duration: null,
    window_outbound_start: null,
    window_outbound_end: null,
    window_return_start: null,
    window_return_end: null,
    min_nights: null,
    max_nights: null,
  };
  let candidates: DatePair[] = [];

  if (dateMode === DateMode.EXACT) {
    const outbound = values["outbound_date"]!;
    const ret = values["return_date"]!;
    if (!isValidDateOnly(outbound)) errors["outbound_date"] = "Choose a valid outbound date.";
    if (!isValidDateOnly(ret)) errors["return_date"] = "Choose a valid return date.";
    if (!errors["outbound_date"] && !errors["return_date"]) {
      if (ret < outbound) {
        errors["return_date"] = "The return date must not be before the outbound date.";
      } else if (ret === outbound) {
        errors["return_date"] = "The return must be at least one night after the departure.";
      } else if (outbound < options.today) {
        errors["outbound_date"] = "The outbound date is in the past.";
      } else {
        dateFields["outbound_date"] = outbound;
        dateFields["return_date"] = ret;
      }
    }
  } else if (dateMode === DateMode.FLEXIBLE_PRESET) {
    const month = intOr(values["flex_month"] ?? "", -1);
    const year = intOr(values["flex_year"] || String(Number(options.today.slice(0, 4))), -1);
    const duration = values["flex_duration"];
    const validDuration =
      duration === FlexDuration.WEEKEND ||
      duration === FlexDuration.ONE_WEEK ||
      duration === FlexDuration.TWO_WEEKS;
    if (!validDuration) errors["flex_duration"] = "Choose a trip length.";
    try {
      const checked = flexiblePresetMonth(month, year, options.today);
      dateFields["flex_month"] = checked.month;
      dateFields["flex_year"] = checked.year;
      if (validDuration) dateFields["flex_duration"] = duration;
    } catch (error) {
      errors["flex_month"] =
        error instanceof DateWindowError ? error.message : "Choose a valid travel month.";
    }
  } else if (dateMode === DateMode.CUSTOM_WINDOW) {
    const start = values["window_outbound_start"]!;
    const end = values["window_outbound_end"]!;
    const returnStart = values["window_return_start"]!;
    const returnEnd = values["window_return_end"]!;
    const minRaw = values["min_nights"]!;
    const maxRaw = values["max_nights"]!;
    const hasReturnStart = returnStart !== "";
    const hasReturnEnd = returnEnd !== "";
    const hasMinNights = minRaw !== "";
    const hasMaxNights = maxRaw !== "";
    const hasReturnWindow = hasReturnStart && hasReturnEnd;
    const hasNightsRange = hasMinNights && hasMaxNights;
    const minNights = hasMinNights ? intOr(minRaw, -1) : null;
    const maxNights = hasMaxNights ? intOr(maxRaw, -1) : null;

    if (!isValidDateOnly(start)) errors["window_outbound_start"] = "Choose a valid earliest departure.";
    if (!isValidDateOnly(end)) errors["window_outbound_end"] = "Choose a valid latest departure.";
    if (hasReturnStart && !isValidDateOnly(returnStart)) {
      errors["window_return_start"] = "Choose a valid earliest return date.";
    }
    if (hasReturnEnd && !isValidDateOnly(returnEnd)) {
      errors["window_return_end"] = "Choose a valid latest return date.";
    }
    if (hasReturnStart !== hasReturnEnd) {
      errors[hasReturnStart ? "window_return_end" : "window_return_start"] =
        "Choose both the earliest and latest return dates.";
    }
    if (hasMinNights !== hasMaxNights) {
      errors[hasMinNights ? "max_nights" : "min_nights"] =
        "Enter both the minimum and maximum trip length.";
    }
    if (!hasReturnStart && !hasReturnEnd && !hasMinNights && !hasMaxNights) {
      errors["window_return_start"] =
        "Give either a return date window or a minimum and maximum trip length.";
    }
    if (minNights !== null && minNights < 1) {
      errors["min_nights"] = "Enter a minimum trip length of at least 1 night.";
    }
    if (maxNights !== null && maxNights < 1) {
      errors["max_nights"] = "Enter a maximum trip length of at least 1 night.";
    }
    if (
      minNights !== null &&
      maxNights !== null &&
      minNights >= 1 &&
      maxNights >= 1 &&
      maxNights < minNights
    ) {
      errors["max_nights"] = "Maximum trip length is shorter than the minimum.";
    }
    if (
      hasReturnWindow &&
      !errors["window_return_start"] &&
      !errors["window_return_end"] &&
      returnEnd < returnStart
    ) {
      errors["window_return_end"] = "The return window ends before it starts.";
    }

    if (
      !errors["window_outbound_start"] &&
      !errors["window_outbound_end"] &&
      !errors["window_return_start"] &&
      !errors["window_return_end"] &&
      !errors["min_nights"] &&
      !errors["max_nights"]
    ) {
      try {
        candidates = orderedPairs(
          generatePairs({
            outboundStart: start,
            outboundEnd: end,
            returnStart: hasReturnWindow ? returnStart : null,
            returnEnd: hasReturnWindow ? returnEnd : null,
            minNights: hasNightsRange ? minNights : null,
            maxNights: hasNightsRange ? maxNights : null,
            notBefore: options.today,
          }),
        );
        dateFields["window_outbound_start"] = start;
        dateFields["window_outbound_end"] = end;
        dateFields["window_return_start"] = hasReturnWindow ? returnStart : null;
        dateFields["window_return_end"] = hasReturnWindow ? returnEnd : null;
        dateFields["min_nights"] = hasNightsRange ? minNights : null;
        dateFields["max_nights"] = hasNightsRange ? maxNights : null;
      } catch (error) {
        const message =
          error instanceof DateWindowError ? error.message : "That window is not usable.";
        // Attach to the field the operator can most usefully change.
        if (/trip length/i.test(message)) errors["max_nights"] = message;
        else if (/return/i.test(message)) errors["window_return_end"] = message;
        else errors["window_outbound_end"] = message;
      }
    }
  }

  const sampledModeAck = values["sampled_mode_ack"] === "on";
  const thresholdBasis = values["threshold_basis"] || ThresholdBasis.PARTY;
  if (
    !Object.values(ThresholdBasis).includes(
      thresholdBasis as (typeof ThresholdBasis)[keyof typeof ThresholdBasis],
    )
  ) {
    errors["threshold_basis"] = "Choose whether the threshold is for the party or each traveler.";
  }
  if (!values["alert_on_threshold"] && !values["alert_on_new_low"]) {
    errors["alert_on_threshold"] = "Turn on at least one alert type so this tracker can notify you.";
  }

  const fields: Record<string, unknown> =
    Object.keys(errors).length > 0
      ? {}
      : {
          name,
          origin,
          destination,
          adults,
          children,
          infants_in_seat: infantsInSeat,
          infants_on_lap: infantsOnLap,
          cabin,
          stops,
          include_airlines: includeAirlines || null,
          exclude_airlines: excludeAirlines || null,
          currency,
          date_mode: dateMode,
          ...dateFields,
          threshold_amount_cents: thresholdCents,
          threshold_basis: thresholdBasis,
          alert_on_threshold: values["alert_on_threshold"] ? 1 : 0,
          alert_on_new_low: values["alert_on_new_low"] ? 1 : 0,
          min_drop_absolute_cents: minDropAbsolute,
          min_drop_percent_bp: minDropPercentBp,
          cooldown_minutes: cooldownMinutes,
          check_interval_minutes: checkIntervalMinutes,
          candidates_per_run: candidatesPerRun,
          sampled_mode_ack: sampledModeAck ? 1 : 0,
          updated_at: nowIso(),
        };

  return {
    values,
    errors,
    fields,
    markets: effectiveMarkets,
    candidates,
    dateMode,
    candidatesPerRun,
    checkIntervalMinutes,
    sampledModeAck,
  };
}

export interface FormBudget {
  estimate: PlanEstimate;
  verdict: BudgetVerdict;
  candidateCount: number;
  candidatesPerScan: number;
  marketCount: number;
}

/** Budget preview for a parsed form, against the live quota snapshot. */
export function budgetFor(
  parsed: ParsedTrackerForm,
  snapshot: QuotaSnapshot,
  maxRequestsPerSearch = 1,
): FormBudget {
  const plan = {
    dateMode: parsed.dateMode,
    marketCount: parsed.markets.length,
    checkIntervalMinutes: Math.max(15, parsed.checkIntervalMinutes),
    candidatesPerRun: parsed.candidatesPerRun,
    totalCandidates: parsed.candidates.length,
  };
  const est = estimate(plan, undefined, maxRequestsPerSearch);
  return {
    estimate: est,
    verdict: assess({
      estimate: est,
      remainingSafe: snapshot.remainingSafe,
      remainingHard: snapshot.remainingHard,
      monthlyLimit: snapshot.monthlyLimit,
      plan,
    }),
    candidateCount: parsed.candidates.length,
    candidatesPerScan:
      parsed.dateMode === DateMode.CUSTOM_WINDOW ? Math.max(1, parsed.candidatesPerRun) : 1,
    marketCount: parsed.markets.length,
  };
}

/** Populate the form from a stored tracker, so editing preserves its config. */
export function valuesFromTracker(tracker: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown): void => {
    if (
      value !== "" &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) out[key] = String(value);
  };

  for (const key of [
    "name",
    "origin",
    "destination",
    "adults",
    "children",
    "infants_in_seat",
    "infants_on_lap",
    "cabin",
    "stops",
    "include_airlines",
    "exclude_airlines",
    "currency",
    "date_mode",
    "outbound_date",
    "return_date",
    "flex_month",
    "flex_year",
    "flex_duration",
    "window_outbound_start",
    "window_outbound_end",
    "window_return_start",
    "window_return_end",
    "min_nights",
    "max_nights",
    "threshold_basis",
    "cooldown_minutes",
    "check_interval_minutes",
    "candidates_per_run",
  ]) {
    put(key, tracker[key]);
  }

  const money = (key: string, column: string): void => {
    const raw = tracker[column];
    if (typeof raw === "number") out[key] = (raw / 100).toFixed(2).replace(/\.00$/, "");
  };
  money("threshold_amount", "threshold_amount_cents");
  money("min_drop_absolute", "min_drop_absolute_cents");
  money("min_drop_percent", "min_drop_percent_bp");

  out["alert_on_threshold"] = tracker["alert_on_threshold"] === 1 ? "on" : "";
  out["alert_on_new_low"] = tracker["alert_on_new_low"] === 1 ? "on" : "";
  out["markets"] = Array.isArray(tracker["markets"]) ? (tracker["markets"] as string[]).join(",") : "";
  return out;
}
