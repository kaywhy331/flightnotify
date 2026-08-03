/**
 * Flexible-window date generation and budget planning.
 *
 * The counts asserted here are what the form promises the operator before they
 * save, and what the scheduler then has to sweep, so a drift between the two
 * would show up as a tracker that never finishes a cycle.
 */

import { describe, expect, it } from "vitest";

import {
  bisectionOrder,
  DateWindowError,
  daysBetween,
  flexiblePresetMonth,
  generatePairs,
  MAX_CANDIDATES,
  orderedPairs,
} from "../src/domain/dates.js";
import { DateMode } from "../src/domain/enums.js";
import { assess, estimate, humanizeDuration, intervalLabel } from "../src/services/planner.js";

describe("bisection ordering", () => {
  it("matches the Python reference sequence", () => {
    // Documented in dates.py: bisection_order(7) -> [3, 1, 5, 0, 2, 4, 6]
    expect(bisectionOrder(7)).toEqual([3, 1, 5, 0, 2, 4, 6]);
  });

  it("is a permutation of every index", () => {
    for (const n of [0, 1, 2, 5, 33, 100]) {
      const order = bisectionOrder(n);
      expect(order).toHaveLength(n);
      expect([...order].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
    }
  });

  it("samples across the window before exhausting the start", () => {
    // The point of bisection: an interrupted sweep still covers the range.
    const order = bisectionOrder(32);
    const firstQuarter = order.slice(0, 8);
    expect(Math.max(...firstQuarter)).toBeGreaterThan(15);
  });
});

describe("date-pair generation", () => {
  it("expands a window by trip length", () => {
    // 3 departure days x 3 lengths (5,6,7 nights) = 9 pairs.
    const pairs = generatePairs({
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-03",
      minNights: 5,
      maxNights: 7,
    });
    expect(pairs).toHaveLength(9);
    for (const pair of pairs) {
      expect(pair.nights).toBeGreaterThanOrEqual(5);
      expect(pair.nights).toBeLessThanOrEqual(7);
      expect(daysBetween(pair.outbound, pair.inbound)).toBe(pair.nights);
    }
  });

  it("produces one pair when the length range is a single value", () => {
    const pairs = generatePairs({
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-01",
      minNights: 7,
      maxNights: 7,
    });
    expect(pairs).toEqual([{ outbound: "2026-09-01", inbound: "2026-09-08", nights: 7 }]);
  });

  it("is deterministic and sorted", () => {
    const args = {
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-05",
      minNights: 3,
      maxNights: 4,
    };
    const a = generatePairs(args);
    const b = generatePairs(args);
    expect(a).toEqual(b);
    const keys = a.map((p) => `${p.outbound}:${p.inbound}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("excludes departures before today", () => {
    const pairs = generatePairs({
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-05",
      minNights: 2,
      maxNights: 2,
      notBefore: "2026-09-04",
    });
    expect(pairs.map((p) => p.outbound)).toEqual(["2026-09-04", "2026-09-05"]);
  });

  it("rejects a reversed outbound window", () => {
    expect(() =>
      generatePairs({ outboundStart: "2026-09-10", outboundEnd: "2026-09-01", minNights: 3 }),
    ).toThrow(DateWindowError);
  });

  it("rejects a max shorter than the min", () => {
    expect(() =>
      generatePairs({
        outboundStart: "2026-09-01",
        outboundEnd: "2026-09-05",
        minNights: 10,
        maxNights: 3,
      }),
    ).toThrow(/Maximum trip length is shorter/);
  });

  it("rejects a window entirely in the past", () => {
    expect(() =>
      generatePairs({
        outboundStart: "2020-01-01",
        outboundEnd: "2020-01-05",
        minNights: 3,
        notBefore: "2026-08-02",
      }),
    ).toThrow(/in the past/);
  });

  it("refuses rather than silently truncating an oversized window", () => {
    // A silently shortened sweep would under-report coverage forever.
    expect(() =>
      generatePairs({
        outboundStart: "2026-09-01",
        outboundEnd: "2027-09-01",
        minNights: 1,
        maxNights: 30,
      }),
    ).toThrow(new RegExp(String(MAX_CANDIDATES)));
  });

  it("requires either a return window or a trip length", () => {
    expect(() =>
      generatePairs({ outboundStart: "2026-09-01", outboundEnd: "2026-09-05" }),
    ).toThrow(/return date window or a minimum/);
  });

  it("never emits a same-day return", () => {
    const pairs = generatePairs({
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-03",
      returnStart: "2026-09-01",
      returnEnd: "2026-09-06",
    });
    expect(pairs.every((p) => p.nights >= 1)).toBe(true);
  });

  it("orders pairs for fair sampling without losing any", () => {
    const pairs = generatePairs({
      outboundStart: "2026-09-01",
      outboundEnd: "2026-09-10",
      minNights: 4,
      maxNights: 5,
    });
    const ordered = orderedPairs(pairs);
    expect(ordered).toHaveLength(pairs.length);
    expect(new Set(ordered.map((p) => `${p.outbound}:${p.inbound}`)).size).toBe(pairs.length);
  });
});

describe("flexible preset month", () => {
  it("accepts a month inside the six-month horizon", () => {
    expect(flexiblePresetMonth(11, 2026, "2026-08-02")).toEqual({ month: 11, year: 2026 });
  });

  it("accepts the current month", () => {
    expect(flexiblePresetMonth(8, 2026, "2026-08-02")).toEqual({ month: 8, year: 2026 });
  });

  it("rejects a past month", () => {
    expect(() => flexiblePresetMonth(7, 2026, "2026-08-02")).toThrow(/already in the past/);
  });

  it("rejects beyond the provider's six-month horizon", () => {
    // Explore returns nothing for these, which would look like "no fares".
    expect(() => flexiblePresetMonth(4, 2027, "2026-08-02")).toThrow(/6 months/);
  });

  it("rejects an out-of-range month", () => {
    expect(() => flexiblePresetMonth(13, 2026, "2026-08-02")).toThrow(/between January/);
  });
});

describe("budget planning", () => {
  const base = {
    marketCount: 1,
    checkIntervalMinutes: 720,
    candidatesPerRun: 1,
    totalCandidates: 0,
  };

  it("costs one search per scan for exact dates", () => {
    const est = estimate({ ...base, dateMode: DateMode.EXACT }, 24 * 30);
    expect(est.callsPerScan).toBe(1);
    expect(est.hasCoverageCycle).toBe(false);
  });

  it("multiplies by the number of markets", () => {
    const one = estimate({ ...base, dateMode: DateMode.EXACT, marketCount: 1 }, 24 * 30);
    const three = estimate({ ...base, dateMode: DateMode.EXACT, marketCount: 3 }, 24 * 30);
    expect(three.callsPerScan).toBe(one.callsPerScan * 3);
    expect(three.callsRemainingThisMonth).toBe(one.callsRemainingThisMonth * 3);
  });

  it("spreads a custom window across scans and reports the sweep length", () => {
    const est = estimate(
      {
        dateMode: DateMode.CUSTOM_WINDOW,
        marketCount: 2,
        checkIntervalMinutes: 720,
        candidatesPerRun: 2,
        totalCandidates: 9,
      },
      24 * 30,
    );
    expect(est.callsPerScan).toBe(4); // 2 pairs x 2 markets
    expect(est.scansPerFullCycle).toBe(5); // ceil(9 / 2)
    expect(est.callsPerFullCycle).toBe(18); // 9 pairs x 2 markets
    expect(est.hasCoverageCycle).toBe(true);
    expect(est.fullCycleMinutes).toBe(5 * 720);
  });

  it("blocks when a single scan exceeds what is left", () => {
    const est = estimate(
      {
        dateMode: DateMode.CUSTOM_WINDOW,
        marketCount: 2,
        checkIntervalMinutes: 720,
        candidatesPerRun: 10,
        totalCandidates: 100,
      },
      24 * 30,
    );
    const verdict = assess({
      estimate: est,
      remainingSafe: 5,
      remainingHard: 15,
      monthlyLimit: 250,
      plan: {
        dateMode: DateMode.CUSTOM_WINDOW,
        marketCount: 2,
        checkIntervalMinutes: 720,
        candidatesPerRun: 10,
        totalCandidates: 100,
      },
    });
    expect(verdict.severity).toBe("blocked");
    expect(verdict.fits).toBe(false);
    expect(verdict.suggestions.length).toBeGreaterThan(0);
  });

  it("warns when the month's schedule exceeds the automation allowance", () => {
    const plan = {
      dateMode: DateMode.EXACT,
      marketCount: 1,
      checkIntervalMinutes: 60,
      candidatesPerRun: 1,
      totalCandidates: 0,
    };
    const est = estimate(plan, 24 * 30);
    const verdict = assess({
      estimate: est,
      remainingSafe: 10,
      remainingHard: 20,
      monthlyLimit: 250,
      plan,
    });
    expect(verdict.severity).toBe("warning");
    expect(verdict.detail).toMatch(/pause scheduled checks/);
  });

  it("passes a configuration that fits", () => {
    const plan = {
      dateMode: DateMode.EXACT,
      marketCount: 1,
      checkIntervalMinutes: 720,
      candidatesPerRun: 1,
      totalCandidates: 0,
    };
    const verdict = assess({
      estimate: estimate(plan, 24 * 30),
      remainingSafe: 240,
      remainingHard: 250,
      monthlyLimit: 250,
      plan,
    });
    expect(verdict.severity).toBe("ok");
    expect(verdict.fits).toBe(true);
  });
});

describe("labels", () => {
  it("names the known schedules", () => {
    expect(intervalLabel(720)).toBe("Every 12 hours");
    expect(intervalLabel(1440)).toBe("Once a day");
    expect(intervalLabel(45)).toBe("Every 45 minutes");
  });

  it("renders sweep durations readably", () => {
    expect(humanizeDuration(30)).toBe("30 minutes");
    expect(humanizeDuration(720)).toBe("12 hours");
    expect(humanizeDuration(60)).toBe("1 hour");
    expect(humanizeDuration(2880)).toBe("2 days");
  });
});
