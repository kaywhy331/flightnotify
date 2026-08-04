/**
 * Provider error taxonomy.
 *
 * Port of `flightnotify/providers/errors.py`. Each error carries the
 * `ErrorCategory` that gets stored on the run row, plus a user-facing sentence
 * that answers the three questions an operator actually has: what failed,
 * whether stored data is safe, and what to do next.
 *
 * The guidance strings are reproduced verbatim from the Python originals --
 * they are the app's contract with the person reading the alert, not incidental
 * wording, and they are what the Python test suite asserts on.
 *
 * Nothing here ever interpolates a credential. Provider-supplied text reaches
 * these constructors only after the adapter has redacted the key from it.
 */

import { ErrorCategory, type ErrorCategoryValue } from "../domain/enums.js";

export class ProviderError extends Error {
  readonly category: ErrorCategoryValue = ErrorCategory.PROVIDER_ERROR;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean = false;
  readonly userMessage: string;
  /** Exact HTTP attempts consumed before this error escaped the adapter. */
  requestCount = 1;

  constructor(message: string, userMessage?: string) {
    super(message);
    // Set explicitly rather than from `new.target`: a minified build would
    // otherwise put a mangled class name into logs and stored error text.
    this.name = "ProviderError";
    this.userMessage = userMessage ?? message;
  }

  guidance(): string {
    return this.userMessage;
  }
}

export class ProviderMissingCredentialsError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.MISSING_CREDENTIALS;

  constructor(message = "SERPAPI_API_KEY is not set.", userMessage?: string) {
    super(
      message,
      userMessage ??
        "No SerpApi key is configured, so no search was made. " +
          "Stored history is unchanged. Add SERPAPI_API_KEY to your .env " +
          "and restart FlightNotify.",
    );
    this.name = "ProviderMissingCredentialsError";
  }
}

export class ProviderAuthError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.INVALID_CREDENTIALS;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "SerpApi rejected the API key, so no search was made and no quota " +
          "was used. Stored history is unchanged. Check the key at " +
          "https://serpapi.com/manage-api-key and update SERPAPI_API_KEY.",
    );
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.RATE_LIMIT;
  override readonly retryable = true;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null, userMessage?: string) {
    super(
      message,
      userMessage ??
        "SerpApi rate-limited this request. Nothing was stored for this " +
          "check and existing history is unchanged. FlightNotify will back " +
          "off and try again on the next scheduled run.",
    );
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderQuotaExhaustedError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.QUOTA_EXHAUSTED;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "The SerpApi account has no searches left this cycle. No search " +
          "was made and stored history is unchanged. Wait for the plan to " +
          "renew, or lower the tracker's check frequency.",
    );
    this.name = "ProviderQuotaExhaustedError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.TIMEOUT;
  override readonly retryable = true;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "The request to SerpApi timed out. No result was stored for this " +
          "check and existing history is unchanged. FlightNotify retries " +
          "with backoff on the next run.",
    );
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderNetworkError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.NETWORK;
  override readonly retryable = true;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "FlightNotify could not reach SerpApi. No result was stored for " +
          "this check and existing history is unchanged. Check this " +
          "machine's network connection.",
    );
    this.name = "ProviderNetworkError";
  }
}

export class ProviderMalformedResponseError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.MALFORMED_RESPONSE;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "SerpApi returned a response FlightNotify could not read. The run " +
          "is recorded as a provider error and stored history is unchanged. " +
          "If this repeats, the provider's response format may have changed.",
    );
    this.name = "ProviderMalformedResponseError";
  }
}

export class ProviderUnsupportedQueryError extends ProviderError {
  override readonly category: ErrorCategoryValue = ErrorCategory.UNSUPPORTED_QUERY;

  constructor(message: string, userMessage?: string) {
    super(
      message,
      userMessage ??
        "SerpApi rejected this search as unsupported. The run is recorded " +
          "and stored history is unchanged. Try a different route, date, " +
          "cabin, market or passenger combination.",
    );
    this.name = "ProviderUnsupportedQueryError";
  }
}
