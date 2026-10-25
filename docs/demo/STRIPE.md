# Demo: paying on Stripe's test checkout

pay_with_saved_card can pay on Stripe's hosted checkout, in **test mode only**:

- `https://buy.stripe.com/test_...` (a test Payment Link)
- `https://checkout.stripe.com/c/pay/cs_test_...` (a test Checkout Session)

A live `cs_live_` session or live Payment Link never counts as a checkout page. `checkout.stripe.dev` doesn't work for this.

## 1. Make the test page (once, about 3 minutes)

1. Sign in to the Stripe Dashboard and switch to a **sandbox / Test mode**. No business details are needed.
2. Product catalogue: add a product, for example "Blue mug", one-time price **$14.00**.
3. Payment Links: create a link for it. Leave **After payment** on *Show confirmation page*, and don't collect shipping.
4. Copy the link. It looks like `https://buy.stripe.com/test_XXXXXXXX`. That is the demo URL.

## 2. Start the agent server

```sh
CLEARCART_BROWSER=ext npm start
```

## 3. Orbi extension options

- **Blocked sites:** remove the `stripe.com` line. The suggested list blocks every `*.stripe.com` page. Put the line back after the recording.
- **Allowed sites:** only in allowlist mode, add `https://buy.stripe.com` and `https://checkout.stripe.com`.
- **Payment cards:** add Stripe's test card `4242 4242 4242 4242`, any future expiry and any 3-digit code. Without a ZIP, Orbi uses `42424` on Stripe's test page, and `demo@example.com` for its email field.
- Reload the extension, and turn Danger mode on if you want the flow without a spoken yes.

## 4. The spoken flow for the recording

Danger mode on:

1. You: "Open buy.stripe.com/test_XXXXXXXX and buy the blue mug."
2. Orbi opens the page and reads the item and the $14.00 total.
3. Orbi (request_checkout, no yes needed): "Placing your order for Blue mug, $14.00 on buy.stripe.com, with your Visa ending 4242."
4. Orbi's own code (pay_with_saved_card) fills the card number, expiry, CVC, name, ZIP and email, then presses **Pay** once. Claude never sees the card.
5. Stripe shows "Thanks for your payment". Orbi says it paid with the card ending in 4242.

Danger mode off: at step 3 Orbi reads the order back and waits for "yes".

pay_with_saved_card refuses if:
- the page total doesn't match what was announced,
- there isn't exactly one Pay button,
- the page isn't a test-mode Stripe page.
