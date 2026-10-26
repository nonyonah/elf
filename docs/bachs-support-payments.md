# Bachs project-support payment link

Both onboarding and Settings use `SupportFooter`, labelled **Help support this
project**. It opens a public reusable Bachs payment link in a new tab. The shared
URL is configured in `settings-next/src/lib/support.ts`:
https://checkout.bachs.io/pay/pl_02b9f8010642.
Do not substitute an expiring checkout session or put a secret API key in this
file. Elf does not collect payment credentials or infer payment success from a
redirect. Supporting the project does not unlock a feature or start a subscription.

## Merchant configuration

1. Create a support product in the Bachs dashboard. Leave its billing cycle unset
   so it is a one-time purchase. Choose a fixed amount or custom/pay-what-you-want
   pricing according to the project owner's preference.
2. Use USD as the base currency and enable adaptive pricing so eligible local
   payment currencies are available. Optional local-currency overrides set exact
   prices; otherwise Bachs handles conversion. Do not restrict checkout to a
   single corridor if all supported methods are intended.
3. Enable `USD_CARD`, `NGN_CARD`, `NGN_BANK_TRANSFER`, and `CRYPTO` in the account's
   checkout settings. Enable the individual crypto assets/networks too. Mobile
   money corridors can provide the additional local currencies below.
4. Create a reusable payment link for the one-time support product and provide
   its public URL. Confirm the methods actually offered in sandbox and live
   checkout; account activation, restrictions, minimums, and checkout currency
   affect availability. A platform-supported method is not proof it is enabled
   for this merchant. A public link grants no authority to edit the merchant’s account settings.
5. Replace the shared URL and build the Settings assets before packaging Elf.
   Users of the published npm package need only the public payment link; they
   should never supply the project's Bachs merchant credentials.

## Collection methods and currencies

| Method | Currency or asset/network | Transaction mode |
|---|---|---|
| Card | USD, NGN | One-time card payment; `USD_CARD` or `NGN_CARD` |
| Bank transfer | NGN | One-time transfer; `NGN_BANK_TRANSFER` |
| Crypto | USDT, USDC, ETH, SOL, BNB, and CELO, with the asset/network choices offered by this live link | One-time on-chain payment; `CRYPTO`, using the exact asset and network shown at checkout |
| Mobile money | GHS, KES, TZS, UGX, XAF, XOF, RWF, MWK, ZMW | One-time mobile-money payment in the selected local currency |

USD bank-transfer collection is not listed in the current collection matrix.
USD ACH/wire/RTP in the payout documentation describe withdrawals, not customer
payment methods. Crypto payout networks likewise differ from collection networks.
Checkout determines the exact supported method and current conversion quote.

Sources checked against Bachs documentation:
- [Products and one-time pricing](https://docs.bachs.io/guides/products/overview)
- [Payment method support and corridors](https://docs.bachs.io/guides/payments/payment-method-support)
- [Collection versus withdrawal currencies](https://docs.bachs.io/for-you/supported-currencies)
- [Checkout pricing and conversion](https://docs.bachs.io/guides/checkout/checkout-sessions)

## Public-link verification — 26 October 2026

An anonymous browser inspection of the configured public link returned
`NGN_BANK_TRANSFER`, `USD_CARD`, `NGN_CARD`, `CRYPTO`, and local mobile-money
corridors. `selected_payment_methods` was null, with no link-specific method
restriction exposed. Pricing had USD as its base, amount 5, and null recurring
interval/count. The form showed a suggested USD 5 contribution with an editable
USD 1–500 range. No email was entered and no payment was submitted.

The live crypto choices included additional networks beyond the documentation's
static collection table. Follow the hosted checkout’s current options rather
than maintaining a conflicting hard-coded currency selector in Elf. The displayed
merchant is Rift Labs and the payment-link title is currently “Buy me coffee”;
renaming that merchant-side title requires the Bachs dashboard. Both Elf footers
use “Help support this project”. This verifies public configuration, not a
successful transaction, live exchange rates, or settlement.
