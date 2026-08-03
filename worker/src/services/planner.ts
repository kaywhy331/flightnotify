/**
 * Call-budget planning shown before a tracker is saved.
 *
 * Port of `flightnotify/services/planner.py`. Every number here is an estimate
 * of *provider searches*, which is what the free plan meters. Cache hits are
 * excluded because they are not billable.
 *
 * This is the difference between a flexible window being a useful feature and
 * an expensive footgun: a 30-day window with a 5-14 night range is over 300
 * date pairs, and across two markets that is more than twice the monthly
 * allowance in a single sweep.
 */

import { DateMode, type DateModeValue } from "../domain/enums.js";
import { monthEnd } from "../time.js";

/** Schedules offered in the UI, coarsest first. */
export const SCHEDULE_CHOICES: readonly (readonly [number, string])[] = [
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Once a day"],
  [2880, "Every 2 days"],
  [10080, "Once a week"],
] as const;

/** Conservative default for a new fixed-date tracker. */
export const DEFAULT_INTERVAL_MINUTES = 720;

export interface PlanInput {
  dateMode: DateModeValue;
  marketCount: number;
  checkIntervalMinutes: number;
  candidatesPerRun: number;
  totalCandidates: number;
}

export interface PlanEstimate {
  callsPerScan: number;
  scansRemainingThisMonth: number;
  callsRemainingThisMonth: number;
  callsPerFullCycle: number;
  scansPerFullCycle: number;
  callsPer30Days: number;
  hasCoverageCycle: boolean;
  /** Wall-clock time for one full sweep at the configured interval. */
  fullCycleMinutes: number;
}

export function hoursRemainingInMonth(now: Date = new Date()): number {
  return Math.max(0, (monthEnd(now).getTime() - now.getTime()) / 3_600_000);
}

export function estimate(plan: PlanInput, nowHoursLeft?: number): PlanEstimate {
  const markets = Math.max(1, plan.marketCount);

  const perScanUnits =
    plan.dateMode === DateMode.CUSTOM_WINDOW ? Math.max(1, plan.candidatesPerRun) : 1;
  const totalUnits =
    plan.dateMode === DateMode.CUSTOM_WINDOW ? Math.max(0, plan.totalCandidates) : 1;

  const callsPerScan = perScanUnits * markets;
  const scansPerCycle = totalUnits ? Math.max(1, Math.ceil(totalUnits / perScanUnits)) : 1;
  const callsPerCycle = totalUnits ? totalUnits * markets : callsPerScan;

  const hoursLeft = nowHoursLeft ?? hoursRemainingInMonth();
  const intervalHours = Math.max(plan.checkIntervalMinutes, 1) / 60;
  const scansLeft = Math.floor(hoursLeft / intervalHours);

  return {
    callsPerScan,
    scansRemainingThisMonth: scansLeft,
    callsRemainingThisMonth: scansLeft * callsPerScan,
    callsPerFullCycle: callsPerCycle,
    scansPerFullCycle: scansPerCycle,
    callsPer30Days: Math.floor((30 * 24) / intervalHours) * callsPerScan,
    hasCoverageCycle: scansPerCycle > 1,
    fullCycleMinutes: scansPerCycle * Math.max(plan.checkIntervalMinutes, 1),
  };
}

export type Severity = "ok" | "warning" | "blocked";

export interface BudgetVerdict {
  fits: boolean;
  severity: Severity;
  headline: string;
  detail: string;
  suggestions: string[];
}

export interface AssessArgs {
  estimate: PlanEstimate;
  remainingSafe: number;
  remainingHard: number;
  monthlyLimit: number;
  plan: PlanInput;
}

/** Explain whether the configuration fits the remaining free allowance. */
export function assess(args: AssessArgs): BudgetVerdict {
  const { estimate: est, remainingSafe, remainingHard, monthlyLimit, plan } = args;
  const needed = est.callsRemainingThisMonth;

  const suggestions: string[] = [];
  if (plan.marketCount > 1) suggestions.push("Compare fewer country markets.");
  if (plan.dateMode === DateMode.CUSTOM_WINDOW) {
    suggestions.push("Narrow the outbound window or the trip-length range.");
    if (plan.candidatesPerRun > 1) suggestions.push("Check fewer date combinations per run.");
  }
  suggestions.push("Check less often.");

  if (est.callsPerScan > remainingHard) {
    return {
      fits: false,
      severity: "blocked",
      headline: "A single scan does not fit the remaining allowance.",
      detail:
        `One scan needs ${est.callsPerScan} provider searches but only ${remainingHard} ` +
        `remain this period (cap ${monthlyLimit}).`,
      suggestions,
    };
  }

  if (needed > remainingSafe) {
    return {
      fits: false,
      severity: "warning",
      headline: "This schedule will not run for the rest of the month.",
      detail:
        `Running ${intervalLabel(plan.checkIntervalMinutes).toLowerCase()} until the period ` +
        `resets needs about ${needed} provider searches; ${remainingSafe} are available to ` +
        "automation. FlightNotify will keep checking until the allowance runs out and then " +
        "pause scheduled checks rather than exceeding the cap.",
      suggestions,
    };
  }

  const coverageNote = est.hasCoverageCycle
    ? ` A full sweep of all date combinations takes ${est.scansPerFullCycle} scans ` +
      `(${est.callsPerFullCycle} searches, about ${humanizeDuration(est.fullCycleMinutes)}).`
    : "";

  return {
    fits: true,
    severity: "ok",
    headline: "This configuration fits the remaining allowance.",
    detail:
      `About ${needed} of ${remainingSafe} available searches for the rest of the period.` +
      coverageNote,
    suggestions: [],
  };
}

export function intervalLabel(minutes: number): string {
  for (const [value, label] of SCHEDULE_CHOICES) {
    if (value === minutes) return label;
  }
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** Render a sweep duration the way an operator would say it. */
export function humanizeDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 48) {
    const whole = Math.round(hours * 10) / 10;
    return `${whole} hour${whole === 1 ? "" : "s"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} day${days === 1 ? "" : "s"}`;
}
