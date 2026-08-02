/**
 * Threshold and historical-low evaluation.
 *
 * Port of `flightnotify/domain/evaluation.py`, working in integer cents.
 *
 * "Historical low" means the lowest comparable fare *FlightNotify has observed*
 * for this tracker's current configuration series. It is not a prediction and
 * is never described as a guaranteed or future minimum.
 */

import {
  AlertType,
  PriceScopeLabel,
  ThresholdBasis,
  type AlertTypeValue,
  type PriceScopeValue,
  type ThresholdBasisValue,
} from "./enums.js";
import { dropPercentBp, perTravelerCents, partyTotalCents } from "./money.js";

export interface NormalizedPrice {
  reportedCents: number;
  scope: PriceScopeValue;
  partyTotalCents: number | null;
  partyTotalIsCalculated: boolean;
  perTravelerCents: number | null;
  perTravelerIsCalculated: boolean;
}

/**
 * Express a reported price on both bases, with provenance.
 *
 * `payingTravelers` counts seats only (adults + children + infants in a seat).
 * Lap infants are excluded: they do not occupy a seat and the provider does not
 * expose their fare component, so including them would understate per-traveler.
 */
export function normalizePrice(
  reportedCents: number,
  scope: PriceScopeValue,
  payingTravelers: number,
): NormalizedPrice {
  const travelers = Math.max(1, payingTravelers);

  if (scope === PriceScopeLabel.PARTY_TOTAL) {
    return {
      reportedCents,
      scope,
      partyTotalCents: reportedCents,
      partyTotalIsCalculated: false,
      perTravelerCents: perTravelerCents(reportedCents, travelers),
      perTravelerIsCalculated: true,
    };
  }

  if (scope === PriceScopeLabel.PER_TRAVELER) {
    return {
      reportedCents,
      scope,
      partyTotalCents: partyTotalCents(reportedCents, travelers),
      partyTotalIsCalculated: true,
      perTravelerCents: reportedCents,
      perTravelerIsCalculated: false,
    };
  }

  // Unknown scope: never derive the other basis -- that is exactly the
  // multiply/divide that could double-count the party.
  return {
    reportedCents,
    scope: PriceScopeLabel.UNKNOWN,
    partyTotalCents: null,
    partyTotalIsCalculated: false,
    perTravelerCents: null,
    perTravelerIsCalculated: false,
  };
}

export function onBasis(price: NormalizedPrice, basis: ThresholdBasisValue): number | null {
  return basis === ThresholdBasis.PARTY ? price.partyTotalCents : price.perTravelerCents;
}

/**
 * The amount to compare against the tracker's threshold.
 *
 * With an `unknown` scope the provider's reported value is used as-is; the UI
 * and alert text say so rather than implying a basis that was never established.
 */
export function comparableCents(
  reportedCents: number,
  scope: PriceScopeValue,
  basis: ThresholdBasisValue,
  payingTravelers: number,
): number {
  const normalized = normalizePrice(reportedCents, scope, payingTravelers);
  return onBasis(normalized, basis) ?? normalized.reportedCents;
}

export interface SeriesState {
  previousBestCents: number | null;
  seriesLowCents: number | null;
  hasBaseline: boolean;
  previouslyMetThreshold: boolean;
}

export interface AlertDecision {
  alertType: AlertTypeValue;
  shouldAlert: boolean;
  reason: string;
}

export interface Evaluation {
  comparableCents: number;
  isBaseline: boolean;
  meetsThreshold: boolean;
  isNewLow: boolean;
  dropAbsoluteCents: number | null;
  dropPercentBp: number | null;
  previousBestCents: number | null;
  previousLowCents: number | null;
  decisions: AlertDecision[];
  alertsToSend: AlertTypeValue[];
}

/** Render cents as Python's `str(Decimal)` would after two-place quantisation. */
function fixed2(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

export interface EvaluateArgs {
  reportedCents: number;
  priceScope: PriceScopeValue;
  thresholdCents: number;
  thresholdBasis: ThresholdBasisValue;
  payingTravelers: number;
  state: SeriesState;
  alertOnThreshold?: boolean;
  alertOnNewLow?: boolean;
  minDropAbsoluteCents?: number | null;
  minDropPercentBp?: number | null;
}

/**
 * Decide what this observation means for the tracker.
 *
 * Rules that matter:
 *   - a price exactly equal to the threshold counts as reaching it;
 *   - the first observation in a series is a baseline: it may fire a threshold
 *     alert, but never a "new low" alert and never a "price drop";
 *   - a new low requires a strictly lower comparable fare than the series low;
 *   - minimum-drop rules gate alerts only when a previous best exists.
 */
export function evaluate(args: EvaluateArgs): Evaluation {
  const {
    reportedCents,
    priceScope,
    thresholdCents,
    thresholdBasis,
    payingTravelers,
    state,
    alertOnThreshold = true,
    alertOnNewLow = true,
    minDropAbsoluteCents = null,
    minDropPercentBp = null,
  } = args;

  const comparable = comparableCents(
    reportedCents,
    priceScope,
    thresholdBasis,
    payingTravelers,
  );

  const isBaseline = !state.hasBaseline;
  const meetsThreshold = comparable <= thresholdCents;
  const previousLow = state.seriesLowCents;
  const isNewLow = !isBaseline && previousLow !== null && comparable < previousLow;

  let dropAbsolute: number | null = null;
  let dropPercent: number | null = null;
  if (state.previousBestCents !== null && state.previousBestCents > 0) {
    dropAbsolute = state.previousBestCents - comparable;
    dropPercent = dropPercentBp(dropAbsolute, state.previousBestCents);
  }

  const minDropBlock = (): string | null => {
    if (
      minDropAbsoluteCents !== null &&
      minDropAbsoluteCents > 0 &&
      (dropAbsolute === null || dropAbsolute < minDropAbsoluteCents)
    ) {
      return (
        `Drop of ${dropAbsolute !== null ? fixed2(dropAbsolute) : "0"} is below the ` +
        `configured minimum of ${fixed2(minDropAbsoluteCents)}.`
      );
    }
    if (
      minDropPercentBp !== null &&
      minDropPercentBp > 0 &&
      (dropPercent === null || dropPercent < minDropPercentBp)
    ) {
      return (
        `Drop of ${dropPercent !== null ? fixed2(dropPercent) : "0"}% is below the ` +
        `configured minimum of ${fixed2(minDropPercentBp)}%.`
      );
    }
    return null;
  };

  const decisions: AlertDecision[] = [];

  // --- threshold ---------------------------------------------------------
  if (!alertOnThreshold) {
    decisions.push({
      alertType: AlertType.THRESHOLD,
      shouldAlert: false,
      reason: "Threshold alerts are turned off.",
    });
  } else if (!meetsThreshold) {
    decisions.push({
      alertType: AlertType.THRESHOLD,
      shouldAlert: false,
      reason: `Observed ${fixed2(comparable)} is above the threshold ${fixed2(thresholdCents)}.`,
    });
  } else if (state.previouslyMetThreshold && !isNewLow && !isBaseline) {
    // Already under threshold on the previous check with no improvement: the
    // dedupe key would catch this, but skipping here avoids creating an event
    // row for an unchanged situation.
    decisions.push({
      alertType: AlertType.THRESHOLD,
      shouldAlert: false,
      reason: "Already under threshold on the previous check with no further improvement.",
    });
  } else {
    const blocked = minDropBlock();
    if (blocked && !isBaseline) {
      decisions.push({ alertType: AlertType.THRESHOLD, shouldAlert: false, reason: blocked });
    } else {
      decisions.push({
        alertType: AlertType.THRESHOLD,
        shouldAlert: true,
        reason: isBaseline
          ? "First observation for this configuration is at or below the threshold."
          : "Fare reached the threshold.",
      });
    }
  }

  // --- new observed low --------------------------------------------------
  if (!alertOnNewLow) {
    decisions.push({
      alertType: AlertType.NEW_LOW,
      shouldAlert: false,
      reason: "New-low alerts are turned off.",
    });
  } else if (isBaseline) {
    decisions.push({
      alertType: AlertType.NEW_LOW,
      shouldAlert: false,
      reason: "This is the baseline observation, not a price drop.",
    });
  } else if (!isNewLow) {
    decisions.push({
      alertType: AlertType.NEW_LOW,
      shouldAlert: false,
      reason:
        `Observed ${fixed2(comparable)} is not below the observed low ` +
        `${previousLow !== null ? fixed2(previousLow) : "None"}.`,
    });
  } else {
    const blocked = minDropBlock();
    if (blocked) {
      decisions.push({ alertType: AlertType.NEW_LOW, shouldAlert: false, reason: blocked });
    } else {
      decisions.push({
        alertType: AlertType.NEW_LOW,
        shouldAlert: true,
        reason: "New lowest fare observed for this tracker.",
      });
    }
  }

  return {
    comparableCents: comparable,
    isBaseline,
    meetsThreshold,
    isNewLow,
    dropAbsoluteCents: dropAbsolute,
    dropPercentBp: dropPercent,
    previousBestCents: state.previousBestCents,
    previousLowCents: previousLow,
    decisions,
    alertsToSend: decisions.filter((d) => d.shouldAlert).map((d) => d.alertType),
  };
}
