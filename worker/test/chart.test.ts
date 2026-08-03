/**
 * Chart and airport-datalist rendering.
 *
 * The SVG is the one piece of markup assembled by string concatenation rather
 * than the html`` tag, so escaping is asserted here explicitly: a hostile
 * airline name in a tooltip must come out inert.
 */

import { describe, expect, it } from "vitest";

import { AIRPORTS, renderAirportDatalist } from "../src/web/airports.js";
import { renderPriceChart, type PricePoint } from "../src/web/chart.js";
import { formatMoney } from "../src/domain/money.js";

const OPTS = { currency: "USD", timeZone: "UTC" };

function point(observedAt: string, amountCents: number, label = "Delta"): PricePoint {
  return { observedAt, amountCents, label };
}

const THREE_POINTS = [
  point("2026-08-01T10:00:00.000Z", 130000),
  point("2026-08-02T10:00:00.000Z", 119900),
  point("2026-08-03T14:15:00.000Z", 129900),
];

describe("renderPriceChart", () => {
  it("renders the empty state as a paragraph, not an empty SVG", () => {
    expect(renderPriceChart([], OPTS)).toBe(
      '<p class="chart-empty">No successful observations yet, so there is nothing to chart.</p>',
    );
  });

  it("centers a single observation instead of pinning it to the left edge", () => {
    const svg = renderPriceChart([point("2026-08-03T14:15:00.000Z", 129900)], OPTS);
    // Midpoint of the plot area: 62 + (720 - 62 - 16) / 2.
    expect(svg).toContain('cx="383.0"');
    expect(svg).toContain("<svg class=\"price-chart\"");
    expect((svg.match(/<circle /g) ?? []).length).toBe(1);
  });

  it("draws grid, area, and line for a multi-point series", () => {
    const svg = renderPriceChart(THREE_POINTS, OPTS);
    expect((svg.match(/class="grid"/g) ?? []).length).toBe(4);
    expect(svg).toContain('<path class="area"');
    expect(svg).toContain('<path class="line"');
    // Area closes back to the plot floor (18 + 208).
    expect(svg).toContain(",226.0 Z");
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);
  });

  it("draws the threshold line and label when the threshold is in range", () => {
    const svg = renderPriceChart(THREE_POINTS, { ...OPTS, thresholdCents: 125000 });
    expect(svg).toContain('class="threshold"');
    expect(svg).toContain(">Threshold</text>");
  });

  it("omits the threshold when none is set, and survives an extreme one", () => {
    expect(renderPriceChart(THREE_POINTS, OPTS)).not.toContain("threshold");
    // A threshold far above every fare joins the y-domain, so rendering must
    // not throw and must still produce a complete SVG.
    const svg = renderPriceChart(THREE_POINTS, { ...OPTS, thresholdCents: 10_000_000 });
    expect(svg).toContain("</svg>");
    expect(svg).toContain('<path class="line"');
  });

  it("marks the low observation with a larger dot-low dot", () => {
    const svg = renderPriceChart(THREE_POINTS, { ...OPTS, lowCents: 119900 });
    expect((svg.match(/class="dot dot-low"/g) ?? []).length).toBe(1);
    expect(svg).toContain('class="dot dot-low" cx=');
    expect((svg.match(/r="4\.5"/g) ?? []).length).toBe(1);
    expect((svg.match(/r="3"/g) ?? []).length).toBe(2);
  });

  it("falls back to the series minimum when no low is provided", () => {
    const svg = renderPriceChart(THREE_POINTS, OPTS);
    expect((svg.match(/class="dot dot-low"/g) ?? []).length).toBe(1);
  });

  it("writes money and local time into the dot tooltips", () => {
    const svg = renderPriceChart(THREE_POINTS, OPTS);
    expect(svg).toContain(`<title>${formatMoney(129900, "USD")} — Aug 3, 2:15 PM — Delta</title>`);
    expect(svg).toContain("$1,199");
  });

  it("respects the display timezone for tooltips and axis labels", () => {
    const svg = renderPriceChart(THREE_POINTS, { ...OPTS, timeZone: "America/Los_Angeles" });
    // 14:15 UTC on Aug 3 is 7:15 AM Pacific.
    expect(svg).toContain("Aug 3, 7:15 AM");
  });

  it("labels the x axis with first, middle, and last dates", () => {
    const svg = renderPriceChart(THREE_POINTS, OPTS);
    expect(svg).toContain('text-anchor="start">Aug 1</text>');
    expect(svg).toContain('text-anchor="middle">Aug 2</text>');
    expect(svg).toContain('text-anchor="end">Aug 3</text>');
  });

  it("exposes the chart to assistive tech via role, aria-label, and desc", () => {
    const svg = renderPriceChart(THREE_POINTS, { ...OPTS, title: "SFO to NRT" });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="SFO to NRT. Line chart of 3 observed fares in USD,');
    expect(svg).toMatch(/<desc>Line chart of 3 observed fares in USD, from .* to .*\.<\/desc>/);
  });

  it("escapes provider-supplied labels and the caller-supplied title", () => {
    const hostile = [point("2026-08-01T10:00:00.000Z", 100000, '<script>alert(1)</script>"')];
    const svg = renderPriceChart(hostile, { ...OPTS, title: 'A "quoted" & <bad> title' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;");
    expect(svg).toContain("A &quot;quoted&quot; &amp; &lt;bad&gt; title");
  });

  it("orders points chronologically regardless of input order", () => {
    const svg = renderPriceChart([...THREE_POINTS].reverse(), OPTS);
    expect(svg).toContain('text-anchor="start">Aug 1</text>');
    expect(svg).toContain('text-anchor="end">Aug 3</text>');
  });
});

describe("AIRPORTS", () => {
  it("contains a substantial curated list with no duplicate codes", () => {
    expect(AIRPORTS.length).toBeGreaterThanOrEqual(100);
    expect(new Set(AIRPORTS.map((a) => a.code)).size).toBe(AIRPORTS.length);
  });

  it("uses uppercase three-letter IATA codes that appear in their own labels", () => {
    for (const airport of AIRPORTS) {
      expect(airport.code).toMatch(/^[A-Z]{3}$/);
      expect(airport.label).toContain(`(${airport.code})`);
    }
  });

  it("includes the Japan gateways alongside the US hubs", () => {
    const codes = new Set(AIRPORTS.map((a) => a.code));
    for (const code of ["NRT", "HND", "KIX", "SFO", "JFK", "ORD", "CUN", "LHR"]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("renders a datalist with escaped ids and labels", () => {
    const markup = renderAirportDatalist("airport-codes");
    expect(markup.startsWith('<datalist id="airport-codes">')).toBe(true);
    expect(markup.endsWith("</datalist>")).toBe(true);
    expect(markup).toContain(
      '<option value="SFO" label="San Francisco – San Francisco International (SFO)">',
    );
    expect((markup.match(/<option /g) ?? []).length).toBe(AIRPORTS.length);

    // The id is caller-supplied; a hostile one must not break out of the tag.
    const hostile = renderAirportDatalist('x"><script>alert(1)</script>');
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("x&quot;&gt;&lt;script&gt;");
  });
});
