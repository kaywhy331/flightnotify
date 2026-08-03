/**
 * HTML rendering.
 *
 * Replaces Jinja2, which is not available in the Workers runtime. The tagged
 * template escapes interpolated values by default, so the type system makes
 * "forgot to escape" the loud case rather than the quiet one: raw markup has to
 * be wrapped in `raw()` explicitly.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as already-safe markup. Every use is a place to look twice. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Interpolable = string | number | boolean | null | undefined | SafeHtml | Interpolable[];

function render(value: Interpolable): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolable[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

export interface Flash {
  level: "success" | "info" | "warning" | "danger";
  message: string;
}

export interface LayoutOptions {
  title: string;
  nav: "dashboard" | "trackers" | "settings" | "none";
  appTimezone: string;
  flashes?: Flash[];
  /** Rendered above the page when configuration is incomplete. */
  setupError?: string | null;
  /** Hides the primary navigation on the sign-in page. */
  authenticated: boolean;
}

/** Faithful port of templates/base.html, including its accessibility affordances. */
export function layout(options: LayoutOptions, content: SafeHtml): SafeHtml {
  const { title, nav, appTimezone, flashes = [], setupError = null, authenticated } = options;

  const navBar = authenticated
    ? html`
        <nav class="site-nav" aria-label="Primary">
          <a href="/" ${raw(nav === "dashboard" ? 'aria-current="page"' : "")}>Dashboard</a>
          <a href="/trackers" ${raw(nav === "trackers" ? 'aria-current="page"' : "")}>Trackers</a>
          <a href="/settings" ${raw(nav === "settings" ? 'aria-current="page"' : "")}>Settings</a>
        </nav>
        <a class="btn btn-primary btn-small" href="/trackers/new">New tracker</a>
      `
    : raw("");

  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title} · FlightNotify</title>
  <link rel="stylesheet" href="/static/app.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>%E2%9C%88</text></svg>">
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>

<header class="site-header">
  <div class="inner">
    <a class="brand" href="/"><span class="glyph" aria-hidden="true">✈</span> FlightNotify</a>
    ${navBar}
  </div>
</header>

<main id="main">
  ${setupError
    ? html`<div class="notice notice-danger" role="alert">
        <strong>FlightNotify is not fully configured.</strong> ${setupError}
      </div>`
    : raw("")}

  ${flashes.length > 0
    ? html`<div role="status" aria-live="polite">
        ${flashes.map((f) => html`<div class="notice notice-${f.level}">${f.message}</div>`)}
      </div>`
    : raw("")}

  ${content}
</main>

<footer class="site-footer">
  <p>
    FlightNotify records prices it has observed through SerpApi. It does not predict future
    minimums and does not guarantee that an advertised fare is still bookable.
    Times shown in ${appTimezone}.
  </p>
</footer>

<script src="/static/app.js" defer></script>
</body>
</html>`;
}

export function htmlResponse(body: SafeHtml, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // This is a private single-user deployment: nothing here should be cached by
  // an intermediary or indexed.
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(body.value, { ...init, headers });
}

export function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({ Location: location, ...extraHeaders });
  return new Response(null, { status: 303, headers });
}
