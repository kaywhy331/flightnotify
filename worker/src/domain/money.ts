/**
 * Money as integer minor units.
 *
 * The Python original used `Decimal` with `ROUND_HALF_UP` quantisation to two
 * places. JavaScript has no decimal type, and routing money through `number`
 * arithmetic would introduce binary-fraction drift that `Decimal` exists to
 * prevent. So money is an integer count of cents everywhere in the Worker, and
 * the only rounding happens here, explicitly, half-up.
 *
 * Parity with the Python implementation is asserted against the generated
 * golden vectors (see test/golden/vectors.json).
 */

/** Largest magnitude we accept before refusing to do arithmetic silently. */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

function assertSafe(value: number, what: string): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new RangeError(`${what} is not a safe integer: ${value}`);
  }
  return value;
}

/**
 * Integer division rounding half away from zero, matching Python's
 * `Decimal.quantize(..., ROUND_HALF_UP)`.
 *
 * Note "half up" in Python's decimal module means half *away from zero*, not
 * half toward positive infinity: -0.5 rounds to -1, not to 0.
 */
export function divideHalfUp(numerator: number, denominator: number): number {
  assertSafe(numerator, "numerator");
  if (denominator === 0) throw new RangeError("division by zero");
  const negative = numerator < 0 !== denominator < 0;
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  const quotient = Math.floor(a / b);
  const twiceRemainder = (a - quotient * b) * 2;
  const rounded = twiceRemainder >= b ? quotient + 1 : quotient;
  return assertSafe(negative ? -rounded : rounded, "quotient");
}

/** Party total -> per traveler. Lap infants never count: they hold no seat. */
export function perTravelerCents(partyCents: number, payingTravelers: number): number {
  return divideHalfUp(partyCents, Math.max(1, payingTravelers));
}

/** Per traveler -> party total. */
export function partyTotalCents(perTraveler: number, payingTravelers: number): number {
  return assertSafe(perTraveler * Math.max(1, payingTravelers), "party total");
}

/**
 * Percentage drop in hundredths of a percent ("basis points" in the column
 * naming), matching Python's `money(drop / previous * 100)`.
 *
 * Computed from the exact integer ratio rather than a floating quotient, so
 * the half-up decision is never taken on an already-rounded value.
 */
export function dropPercentBp(dropCents: number, previousCents: number): number | null {
  if (previousCents <= 0) return null;
  return divideHalfUp(dropCents * 10_000, previousCents);
}

/**
 * Render cents the way Python's canonicaliser renders a `Decimal`:
 * `format(value.normalize(), "f")` -- trailing zeros stripped, no bare
 * trailing point.
 *
 * This feeds fingerprint input, so it is load-bearing for alert
 * deduplication: 1042 and 1042.00 must produce the identical string, or the
 * same fare would alert twice.
 */
export function decimalStringFromCents(cents: number): string {
  assertSafe(cents, "cents");
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;

  let body: string;
  if (fraction === 0) {
    body = String(whole);
  } else if (fraction % 10 === 0) {
    body = `${whole}.${fraction / 10}`;
  } else {
    body = `${whole}.${String(fraction).padStart(2, "0")}`;
  }
  return negative && abs !== 0 ? `-${body}` : body;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
};

/** Group the integer part with commas, as Python's `,` format spec does. */
function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** UI and Telegram rendering. Mirrors `flightnotify.domain.pricing.format_money`. */
export function formatMoney(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined) return "-";
  assertSafe(cents, "cents");
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;

  const body =
    fraction === 0
      ? groupThousands(String(whole))
      : `${groupThousands(String(whole))}.${String(fraction).padStart(2, "0")}`;
  const signed = negative ? `-${body}` : body;

  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${signed}` : `${signed} ${code}`;
}

/** Parse a decimal string ("1300", "1300.50") into cents, half-up. */
export function centsFromDecimalString(text: string): number {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`not a decimal amount: ${text}`);
  }
  const negative = trimmed.startsWith("-");
  const [wholePart, fractionPart = ""] = trimmed.replace(/^-/, "").split(".");
  const whole = Number(wholePart);
  // Round anything beyond two places half-up rather than truncating.
  const padded = (fractionPart + "000").slice(0, 3);
  const hundredths = Number(padded.slice(0, 2));
  const thousandths = Number(padded.slice(2, 3));
  let cents = whole * 100 + hundredths + (thousandths >= 5 ? 1 : 0);
  cents = assertSafe(cents, "cents");
  return negative ? -cents : cents;
}

export { MAX_SAFE_CENTS };
