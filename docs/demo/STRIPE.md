# Demo: paying on Stripe's test checkout

pay_now can pay on Stripe's hosted checkout, in **test mode only**:

- `https://buy.stripe.com/test_...` (a test Payment Link)
- `https://checkout.stripe.com/c/pay/cs_test_...` (a test Checkout Session)

A live `cs_live_` session or live Payment Link never counts as a checkout page.

`checkout.stripe.dev` doesn't work for this. It shows the form inside a `js.stripe.com` iframe, and Orbi's extension only reads and fills the top frame.

## 1. Make the test page (once, about 3 minutes)

1. Sign in to the Stripe Dashboard and switch to a **sandbox / Test mode**. No business details are needed.
2. Product catalogue: add a product, for example "Blue mug", one-time price **$14.00**.
3. Payment Links: create a link for it. Leave **After payment** on *Show confirmation page*, and don't collect shipping.
4. Copy the link. It looks like `https://buy.stripe.com/test_XXXXXXXX`. That is the demo URL.

## 2. Start the agent server

```sh
CLEARCART_BROWSER=ext CLEARCART_PAY_ORIGINS=https://buy.stripe.com,https://checkout.stripe.com npm start
```

`CLEARCART_PAY_ORIGINS` is read at startup, so put it on the command line, not in `.env`.

## 3. Orbi extension options

- **Allowed sites:** add `https://buy.stripe.com` and `https://checkout.stripe.com`. The extension only arms the Pay button on these sites.
- **Blocked sites:** remove the `stripe.com` line. The suggested list blocks every `*.stripe.com` page. Put the line back after the recording.
- Reload the extension so it picks up the new `fill_payment` (billing ZIP and email).
- Danger mode on, if you want the flow without a spoken yes.

## 4. Put Stripe's test card in the Keychain

This replaces the `clearcart-card` item (`-U`). The value is JSON. `zip` and `email` are optional; without them, pay_now uses `42424` and `demo@example.com`.

```sh
security add-generic-password -U -s clearcart-card -a demo \
  -l "Orbi demo card (Stripe test 4242)" \
  -w '{"name":"<NAME ON CARD>","number":"4242424242424242","exp":"<MM/YY in the future>","csc":"<any 3 digits>","zip":"<any 5 digits>","email":"<demo email>"}'
```

Don't print the item back. pay_now reads it only when it pays.

## 5. The spoken flow for the recording

Danger mode on:

1. You: "Open buy.stripe.com/test_XXXXXXXX and buy the blue mug."
2. Orbi opens the page and reads the item and the $14.00 total.
3. Orbi (request_checkout, no yes needed): "Placing your order for Blue mug, $14.00."
4. Orbi (pay_now) fills the card number, expiry, CVC, name, ZIP and email itself, then presses **Pay** once.
5. Stripe shows "Thanks for your payment". Orbi says it paid with the card ending in 4242.

Danger mode off: at step 3 Orbi reads the order back and waits for "yes".

pay_now refuses if:
- the page total doesn't match what was announced,
- there isn't exactly one Pay button,
- the page isn't a test-mode Stripe page on a listed origin.
