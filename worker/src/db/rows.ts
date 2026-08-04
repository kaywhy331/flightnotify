/**
 * Row shapes as D1 returns them.
 *
 * These mirror the committed D1 migrations exactly, including
 * the `_cents` / `_bp` suffixes and the INTEGER-as-boolean columns. Keeping the
 * raw shape separate from the domain shape means a schema change fails at the
 * type level here rather than surfacing as a wrong number three layers up.
 */

export type SqlBool = 0 | 1;

export interface TrackerRow {
  id: number;
  name: string;
  status: string;

  origin: string;
  destination: string;
  adults: number;
  children: number;
  infants_in_seat: number;
  infants_on_lap: number;
  cabin: string;
  stops: string;
  include_airlines: string | null;
  exclude_airlines: string | null;

  date_mode: string;
  outbound_date: string | null;
  return_date: string | null;
  flex_month: number | null;
  flex_year: number | null;
  flex_duration: string | null;
  window_outbound_start: string | null;
  window_outbound_end: string | null;
  window_return_start: string | null;
  window_return_end: string | null;
  min_nights: number | null;
  max_nights: number | null;

  currency: string;
  threshold_amount_cents: number;
  threshold_basis: string;

  alert_on_threshold: SqlBool;
  alert_on_new_low: SqlBool;
  min_drop_absolute_cents: number | null;
  min_drop_percent_bp: number | null;
  cooldown_minutes: number;

  check_interval_minutes: number;
  candidates_per_run: number;
  sampled_mode_ack: SqlBool;
  next_run_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;

  lock_owner: string | null;
  lock_expires_at: string | null;

  current_config_version_id: number | null;
  series_started_at: string | null;

  latest_price_cents: number | null;
  latest_observation_id: number | null;
  latest_observed_at: string | null;
  low_price_cents: number | null;
  low_observation_id: number | null;
  low_observed_at: string | null;
  last_threshold_met: SqlBool;

  coverage_cycle: number;
  last_error_category: string | null;
  last_error_message: string | null;

  created_at: string;
  updated_at: string;
}

export interface TrackerMarketRow {
  id: number;
  tracker_id: number;
  market: string;
  priority: number;
}

export interface TrackerConfigVersionRow {
  id: number;
  tracker_id: number;
  version: number;
  fingerprint: string;
  payload: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface FlexibleDateCandidateRow {
  id: number;
  tracker_id: number;
  config_version_id: number;
  outbound_date: string;
  return_date: string;
  nights: number;
  order_index: number;
  cycle: number;
  status: string;
  last_checked_at: string | null;
  last_run_id: number | null;
  check_count: number;
  last_price_cents: number | null;
}

export interface FlexibleCandidateMarketRow {
  id: number;
  candidate_id: number;
  market: string;
  cycle: number;
  status: string;
  last_checked_at: string | null;
  last_run_id: number | null;
  check_count: number;
  last_price_cents: number | null;
}

export interface SearchRunRow {
  id: number;
  tracker_id: number;
  config_version_id: number | null;
  batch_id: string;
  trigger: string;
  endpoint: string;
  market: string;
  currency: string;
  outbound_date: string | null;
  return_date: string | null;
  query_fingerprint: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  provider_request_count: number;
  cache_status: string;
  coverage_cycle: number | null;
  coverage_state: string;
  coverage_checked: number | null;
  coverage_total: number | null;
  offers_found: number;
  best_observation_id: number | null;
  error_category: string;
  error_message: string | null;
  skip_reason: string | null;
  raw_excerpt: string | null;
}

export interface FareObservationRow {
  id: number;
  search_run_id: number;
  tracker_id: number;
  config_version_id: number | null;
  itinerary_fingerprint: string;
  price_amount_cents: number;
  currency: string;
  price_scope: string;
  per_traveler_amount_cents: number | null;
  per_traveler_is_calculated: SqlBool;
  party_total_amount_cents: number | null;
  party_total_is_calculated: SqlBool;
  origin: string | null;
  destination: string | null;
  outbound_date: string | null;
  return_date: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  airlines: string | null;
  flight_numbers: string | null;
  stops: number | null;
  duration_minutes: number | null;
  cabin: string | null;
  segments: string | null;
  layovers: string | null;
  booking_link: string | null;
  search_link: string | null;
  market: string;
  observed_at: string;
  eligible: SqlBool;
  exclusion_reason: string | null;
  is_best_of_run: SqlBool;
}

export interface AlertEventRow {
  id: number;
  tracker_id: number | null;
  config_version_id: number | null;
  observation_id: number | null;
  alert_type: string;
  dedupe_key: string;
  message_text: string;
  delivery_state: string;
  attempts: number;
  last_error: string | null;
  telegram_message_id: number | null;
  response_meta: string | null;
  created_at: string;
  delivered_at: string | null;
  retryable: SqlBool;
  next_attempt_at: string | null;
  claim_owner: string | null;
  claim_expires_at: string | null;
}

export interface ProviderUsageRow {
  id: number;
  provider: string;
  period: string;
  local_searches: number;
  provider_searches_per_month: number | null;
  provider_searches_left: number | null;
  provider_this_month_usage: number | null;
  provider_plan_name: string | null;
  provider_account_email_masked: string | null;
  provider_rate_limit_per_hour: number | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export interface SchedulerStateRow {
  id: number;
  lock_owner: string | null;
  lock_expires_at: string | null;
  started_at: string | null;
  last_tick_at: string | null;
  tick_count: number;
  last_error: string | null;
  last_sweep_state: string | null;
  last_sweep_at: string | null;
  last_cleanup_at: string | null;
}

export interface CronRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  cron: string | null;
  outcome: string;
  lease_acquired: SqlBool;
  lease_owner: string | null;
  trackers_selected: number;
  trackers_completed: number;
  queries_executed: number;
  provider_failures: number;
  telegram_failures: number;
  alerts_sent: number;
  work_remaining: number;
  detail: string | null;
}

export interface AppSettingRow {
  key: string;
  value: string | null;
  updated_at: string;
}

export interface TelegramUpdateRow {
  update_id: number;
  state: "processing" | "ready" | "delivered" | "ignored" | "failed";
  chat_id: string | null;
  command: string | null;
  reply_text: string | null;
  received_at: string;
  updated_at: string;
  delivery_attempts: number;
  last_error: string | null;
}

export interface AuthThrottleRow {
  key: string;
  fail_count: number;
  first_failed_at: string | null;
  last_failed_at: string | null;
  locked_until: string | null;
}

/** A tracker plus the joined data every view needs, fetched without N+1. */
export interface TrackerWithMarkets extends TrackerRow {
  markets: string[];
}

export const toBool = (value: number | null | undefined): boolean => value === 1;
export const fromBool = (value: boolean): SqlBool => (value ? 1 : 0);

export function parseJsonColumn<T>(value: string | null): T | null {
  if (value === null || value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    // Matches the Python JSONEncoded type, which returns None rather than
    // raising when a legacy row holds something unparseable.
    return null;
  }
}
