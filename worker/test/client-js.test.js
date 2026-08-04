import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { APP_JS } from "../src/web/static-assets.js";
import { trackerFormPage } from "../src/web/views.js";

const DEFAULT_ESTIMATE = {
  headline: "This configuration fits the remaining allowance.",
  detail: "The full sweep is affordable.",
  calls_per_scan: 1,
  max_calls_per_scan: 3,
  remaining_safe: 244,
  monthly_limit: 250,
  candidate_count: 0,
  scans_per_full_cycle: 1,
  calls_per_full_cycle: 1,
  max_calls_per_full_cycle: 3,
  suggestions: [],
  date_errors: [],
  severity: "ok",
};

function formHtml(values) {
  return trackerFormPage({
    trackerId: null,
    errors: {},
    values,
    csrf: "csrf-for-client-contract-test",
    today: "2026-08-03",
    budget: null,
    availableMarkets: ["us", "gb"],
  }).value;
}

function boot(values, estimate = DEFAULT_ESTIMATE, fetchImpl) {
  const dom = new JSDOM(`<!doctype html><body>${formHtml(values)}</body>`, {
    runScripts: "outside-only",
    url: "https://flightnotify.example/trackers/new",
  });
  const fetchMock = vi.fn(
    fetchImpl ??
      (async (..._args) => ({
        ok: true,
        json: async () => estimate,
      })),
  );
  Object.defineProperty(dom.window, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  dom.window.eval(APP_JS);
  return { dom, fetchMock };
}

describe("browser-script contract", () => {
  it("toggles the real form's date groups and submission fields", () => {
    const { dom } = boot({ date_mode: "exact" });
    try {
      const document = dom.window.document;
      const exact = document.querySelector('[data-date-group="exact"]');
      const custom = document.querySelector('[data-date-group="custom_window"]');
      const returnStart = document.querySelector("#window_return_start");
      const customRadio = document.querySelector("#mode-custom_window");

      expect(exact?.hidden).toBe(false);
      expect(custom?.hidden).toBe(true);
      expect(returnStart?.disabled).toBe(true);

      expect(customRadio).not.toBeNull();
      customRadio.checked = true;
      customRadio.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      expect(exact?.hidden).toBe(true);
      expect(custom?.hidden).toBe(false);
      expect(returnStart?.disabled).toBe(false);
      expect(document.querySelector("#outbound_date")?.disabled).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("posts return-window fields and escapes estimate text before rendering", async () => {
    const hostile = {
      ...DEFAULT_ESTIMATE,
      headline: '<img src=x onerror="alert(1)">',
      detail: "Use <script>alert(2)</script> dates.",
      calls_per_scan: 2,
      candidate_count: 9,
      scans_per_full_cycle: 5,
      calls_per_full_cycle: 9,
      suggestions: ["Try <b>fewer</b> markets."],
      date_errors: ["Return <svg onload=alert(3)> is invalid."],
      severity: "warning",
    };
    const { dom, fetchMock } = boot(
      {
        date_mode: "custom_window",
        window_outbound_start: "2026-10-01",
        window_outbound_end: "2026-10-03",
        window_return_start: "2026-10-08",
        window_return_end: "2026-10-10",
      },
      hostile,
    );

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const init = fetchMock.mock.calls[0]?.[1];
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/estimate");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "X-Requested-With": "fetch" });
      expect(init?.body?.get("window_return_start")).toBe("2026-10-08");
      expect(init?.body?.get("window_return_end")).toBe("2026-10-10");

      const box = dom.window.document.querySelector("#budget-estimate");
      await vi.waitFor(() => expect(box?.hidden).toBe(false));
      expect(box?.querySelector("img, script, svg, b")).toBeNull();
      expect(box?.textContent).toContain('<img src=x onerror="alert(1)">');
      expect(box?.textContent).toContain("<script>alert(2)</script>");
      expect(box?.textContent).toContain("<b>fewer</b>");
      expect(box?.textContent).toContain("<svg onload=alert(3)>");
    } finally {
      dom.window.close();
    }
  });

  it("ignores a stale estimate that resolves after a newer form request", async () => {
    const pending = [];
    const fetchImpl = () =>
      new Promise((resolve) => {
        pending.push(resolve);
      });
    const { dom, fetchMock } = boot({ date_mode: "exact" }, DEFAULT_ESTIMATE, fetchImpl);

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const adults = dom.window.document.querySelector("#adults");
      adults.value = "3";
      adults.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      pending[1]({
        ok: true,
        json: async () => ({ ...DEFAULT_ESTIMATE, headline: "Current estimate" }),
      });
      const box = dom.window.document.querySelector("#budget-estimate");
      await vi.waitFor(() => expect(box?.textContent).toContain("Current estimate"));

      pending[0]({
        ok: true,
        json: async () => ({ ...DEFAULT_ESTIMATE, headline: "Stale estimate" }),
      });
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      expect(box?.textContent).toContain("Current estimate");
      expect(box?.textContent).not.toContain("Stale estimate");
    } finally {
      dom.window.close();
    }
  });
});
