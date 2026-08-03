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
  TrackerStatus,
  type DateModeValue,
} from "../domain/enums.js";
import {
  DateWindowError,
  flexiblePresetMonth,
  generatePairs,
  orderedPairs,
  type DatePair,
} from "../domain/dates.js";
import { centsFromDecimalString } from "../domain/money.js";
import { assess, estimate, type BudgetVerdict, type PlanEstimate } from "../services/planner.js";
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IATA_RE = /^[A-Z]{3}$/;
const MARKET_RE = /^[a-z]{2}$/;

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
  const get = (key: string): string => String(form.get(key) ?? "").trim();
  const values: Record<string, string> = {};
  for (const key of VALUE_KEYS) values[key] = get(key);
  values["alert_on_threshold"] = form.get("alert_on_threshold") ? "on" : "";
  values["alert_on_new_low"] = form.get("alert_on_new_low") ? "on" : "";
  values["sampled_mode_ack"] = form.get("sampled_mode_ack") ? "on" : "";

  const errors: Record<string, string> = {};

  // --- markets ----------------------------------------------------------
  const rawMarkets = form
    .getAll("markets")
    .map((m) => String(m).trim().toLowerCase())
    .filter((m) => m !== "");
  const markets = [...new Set(rawMarkets)].filter((m) => MARKET_RE.test(m));
  if (rawMarkets.length > 0 && markets.length === 0) {
    errors["markets"] = "Use two-letter country codes such as us or gb.";
  }
  const effectiveMarkets = markets.length > 0 ? markets : [options.defaultMarket];
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
  if (checkIntervalMinutes < 15) {
    errors["check_interval_minutes"] = "The minimum interval is 15 minutes.";
  }
  const cooldownMinutes = intOr(values["cooldown_minutes"] || "360", -1);
  if (cooldownMinutes < 0) errors["cooldown_minutes"] = "Cannot be negative.";
  const candidatesPerRun = Math.max(1, intOr(values["candidates_per_run"] || "1", 1));

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
    if (!DATE_RE.test(outbound)) errors["outbound_date"] = "Choose an outbound date.";
    if (!DATE_RE.test(ret)) errors["return_date"] = "Choose a return date.";
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

    if (!DATE_RE.test(start)) errors["window_outbound_start"] = "Choose the earliest departure.";
    if (!DATE_RE.test(end)) errors["window_outbound_end"] = "Choose the latest departure.";
    if (hasReturnStart && !DATE_RE.test(returnStart)) {
      errors["window_return_start"] = "Choose a valid earliest return date.";
    }
    if (hasReturnEnd && !DATE_RE.test(returnEnd)) {
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
          cabin: values["cabin"] || Cabin.ECONOMY,
          stops: values["stops"] || StopsPreference.ANY,
          include_airlines: values["include_airlines"] || null,
          exclude_airlines: values["exclude_airlines"] || null,
          currency,
          date_mode: dateMode,
          ...dateFields,
          threshold_amount_cents: thresholdCents,
          threshold_basis: values["threshold_basis"] || ThresholdBasis.PARTY,
          alert_on_threshold: values["alert_on_threshold"] ? 1 : 0,
          alert_on_new_low: values["alert_on_new_low"] ? 1 : 0,
          min_drop_absolute_cents: minDropAbsolute,
          min_drop_percent_bp: minDropPercentBp,
          cooldown_minutes: cooldownMinutes,
          check_interval_minutes: checkIntervalMinutes,
          candidates_per_run: candidatesPerRun,
          sampled_mode_ack: sampledModeAck ? 1 : 0,
          status: TrackerStatus.ACTIVE,
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
  marketCount: number;
}

/** Budget preview for a parsed form, against the live quota snapshot. */
export function budgetFor(parsed: ParsedTrackerForm, snapshot: QuotaSnapshot): FormBudget {
  const plan = {
    dateMode: parsed.dateMode,
    marketCount: parsed.markets.length,
    checkIntervalMinutes: Math.max(15, parsed.checkIntervalMinutes),
    candidatesPerRun: parsed.candidatesPerRun,
    totalCandidates: parsed.candidates.length,
  };
  const est = estimate(plan);
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
    marketCount: parsed.markets.length,
  };
}

/** Populate the form from a stored tracker, so editing preserves its config. */
export function valuesFromTracker(tracker: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined && value !== "") out[key] = String(value);
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
