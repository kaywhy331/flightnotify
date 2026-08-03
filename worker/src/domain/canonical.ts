/**
 * Byte-exact reimplementation of the Python canonical JSON encoding.
 *
 * Fingerprints are SHA-256 digests over this encoding, and one of those
 * fingerprints identifies a tracker's comparison series while another is the
 * alert deduplication key. So this file is not "a JSON serialiser" -- it is
 * the compatibility contract with the existing production database. A single
 * byte of difference would re-key every alert and orphan the imported price
 * history behind a new series.
 *
 * Reproduced from `flightnotify/domain/fingerprints.py`:
 *
 *   json.dumps(_canonical(payload), sort_keys=True, separators=(",", ":"))
 *
 * with `ensure_ascii=True` (Python's default), which `JSON.stringify` does not
 * do. The differences that actually bite, and are handled below:
 *
 *   - dict entries whose value is None are dropped entirely, so {"a":1,"b":null}
 *     and {"a":1} hash identically; nulls inside *lists* are preserved;
 *   - every code unit above 0x7e is escaped as \uXXXX with lowercase hex,
 *     including 0x7f (DEL), which JSON.stringify leaves literal;
 *   - keys sort by code point, not by UTF-16 code unit.
 *
 * Decimals are converted to their Python `format(normalize(), "f")` string by
 * the caller (see money.decimalStringFromCents) before they reach here, which
 * is what Python's canonicaliser does to a Decimal too.
 */

export type CanonicalInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonicalInput[]
  | { [key: string]: CanonicalInput };

/** Compare by Unicode code point, matching Python's `sorted()` on `str`. */
function compareCodePoints(a: string, b: string): number {
  const aChars = Array.from(a);
  const bChars = Array.from(b);
  const shared = Math.min(aChars.length, bChars.length);
  for (let i = 0; i < shared; i += 1) {
    const ac = aChars[i]!.codePointAt(0)!;
    const bc = bChars[i]!.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
  return aChars.length - bChars.length;
}

const SHORT_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

/** Python `json.encoder.py_encode_basestring_ascii` equivalent. */
function encodeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (code < 0x20) {
      out += SHORT_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code < 0x7f) {
      out += ch;
    } else {
      // Escapes each UTF-16 code unit separately, so an astral character
      // becomes a surrogate pair of escapes -- exactly what Python emits.
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out + '"';
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot canonicalise non-finite number: ${value}`);
  }
  return String(value);
}

/**
 * Serialise an already-canonical value tree. Applies the None-dropping and key
 * ordering rules inline, so the tree does not need a separate rewrite pass.
 */
function encode(value: CanonicalInput): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);

  if (Array.isArray(value)) {
    // Python keeps None inside a list, encoding it as null.
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }

  const entries = Object.entries(value)
    // Mirrors `if v is not None` in the dict comprehension: filtered on the
    // *original* value, before recursion.
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b));

  return `{${entries.map(([k, v]) => `${encodeString(k)}:${encode(v)}`).join(",")}}`;
}

/** The exact byte sequence Python would hash. Exported for testing. */
export function canonicalJson(payload: CanonicalInput): string {
  return encode(payload);
}
