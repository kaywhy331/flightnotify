"""Price-scope normalization.

SerpApi's Google Flights documentation describes the ``price`` field only as
"This ticket price in the selected currency" and never states whether it covers
one traveler or the whole selected party. FlightNotify therefore treats the
interpretation as an explicit, configurable, *labelled* fact rather than a
silent assumption:

* the configured scope is stored on every observation;
* a value derived from the other basis is always marked ``calculated``;
* an ``unknown`` scope disables derivation entirely instead of guessing.

The opt-in live check ``tests/live/test_price_scope_live.py`` verifies the
account's real behaviour with two searches.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from ..enums import PriceScopeLabel, ThresholdBasis

CENTS = Decimal("0.01")


def money(value: Decimal | int | float | str) -> Decimal:
    """Quantize to two decimal places using half-up rounding."""
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return value.quantize(CENTS, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class NormalizedPrice:
    """A provider price expressed on both bases, with provenance."""

    reported_amount: Decimal
    scope: PriceScopeLabel
    party_total: Decimal | None
    party_total_is_calculated: bool
    per_traveler: Decimal | None
    per_traveler_is_calculated: bool

    def on_basis(self, basis: ThresholdBasis) -> Decimal | None:
        if basis is ThresholdBasis.PARTY:
            return self.party_total
        return self.per_traveler

    def basis_is_calculated(self, basis: ThresholdBasis) -> bool:
        if basis is ThresholdBasis.PARTY:
            return self.party_total_is_calculated
        return self.per_traveler_is_calculated


def normalize_price(
    reported: Decimal | int | float | str,
    *,
    scope: PriceScopeLabel,
    paying_travelers: int,
) -> NormalizedPrice:
    """Express ``reported`` as both a party total and a per-traveler amount.

    ``paying_travelers`` counts seats only (adults + children + infants in a
    seat). Lap infants are excluded because they do not occupy a seat and the
    provider does not expose their fare component, so including them would
    understate the per-traveler figure.
    """
    amount = money(reported)
    travelers = max(1, paying_travelers)

    if scope is PriceScopeLabel.PARTY_TOTAL:
        return NormalizedPrice(
            reported_amount=amount,
            scope=scope,
            party_total=amount,
            party_total_is_calculated=False,
            per_traveler=money(amount / travelers),
            per_traveler_is_calculated=True,
        )

    if scope is PriceScopeLabel.PER_TRAVELER:
        return NormalizedPrice(
            reported_amount=amount,
            scope=scope,
            party_total=money(amount * travelers),
            party_total_is_calculated=True,
            per_traveler=amount,
            per_traveler_is_calculated=False,
        )

    # Unknown scope: never derive the other basis - that is exactly the
    # multiply/divide that could double-count the party.
    return NormalizedPrice(
        reported_amount=amount,
        scope=PriceScopeLabel.UNKNOWN,
        party_total=None,
        party_total_is_calculated=False,
        per_traveler=None,
        per_traveler_is_calculated=False,
    )


def comparable_amount(
    *,
    reported_amount: Decimal,
    scope: PriceScopeLabel | str,
    basis: ThresholdBasis | str,
    paying_travelers: int,
) -> Decimal:
    """The amount to compare against the tracker's threshold.

    With an ``unknown`` scope the provider's reported value is used as-is; the
    UI and alert text say so rather than implying a basis that was never
    established.
    """
    scope = PriceScopeLabel(scope)
    basis = ThresholdBasis(basis)
    normalized = normalize_price(reported_amount, scope=scope, paying_travelers=paying_travelers)
    value = normalized.on_basis(basis)
    return value if value is not None else normalized.reported_amount


def format_money(amount: Decimal | None, currency: str) -> str:
    """Render an amount for the UI and Telegram messages."""
    if amount is None:
        return "-"
    quantized = money(amount)
    whole = quantized == quantized.to_integral_value()
    body = f"{quantized:,.0f}" if whole else f"{quantized:,.2f}"
    symbol = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CAD": "CA$", "AUD": "A$"}.get(
        currency.upper()
    )
    return f"{symbol}{body}" if symbol else f"{body} {currency.upper()}"
