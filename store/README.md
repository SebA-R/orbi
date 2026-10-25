# store

Demo online store for the Clearcart MVP ("Elm Street Pharmacy"). Plain server-rendered HTML on `node:http`, no dependencies. See `docs/CONTRACTS.md` ("Demo store").

## Run

```
cd store
npm start        # http://localhost:4000 (override with STORE_PORT)
```

State is in memory (one demo cart); restarting the server resets it. `POST /reset` empties the cart without a restart.

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | Search box and a few featured products |
| `GET /search?q=` | Results list: each links to `/product/:id`, with name, price, size or count, rating |
| `GET /product/:id` | Details and an "Add to cart" form (`POST /cart/add`, fields `product_id`, `quantity`) |
| `POST /cart/add` | Adds the item, redirects to `/cart` |
| `POST /cart/remove` | Removes an item (`product_id`) |
| `GET /cart` | Items, the pre-checked `addon_subscription` checkbox (+$4.99), and `#order-total` |
| `POST /cart/update` | Saves the checkbox state and redirects to `/checkout` ("Proceed to checkout"). The cart page also calls it on checkbox change (`ajax=1`, JSON reply) so the choice sticks even if the shopper goes straight to `/checkout` |
| `GET /checkout` | Plain inputs `address`, `cc-name`, `cc-number`, `cc-exp`, `cc-csc`; submit `#place-order`; order summary with `#order-total` |
| `POST /checkout` | Visa-only (starts with 4), Luhn check, exp MM/YY not in the past, 3 to 4 digit CSC; mocked Visa authorization; redirects to `/order/:id` |
| `GET /order/:id` | Items, `#order-total`, `#card-last4`, `#approval-code` |

Totals are subtotal + add-on (if checked) + 7.25% estimated tax; shipping is free. The add-on is pre-checked again for every new cart.

The full card number and CSC are never stored, logged, or echoed: a failed submit re-renders the form with only the name, expiry and address kept, and the order keeps only the last 4 digits. The server logs only the order id and total.

Test card: `4111 1111 1111 1111` (published Visa test number), any future expiry, any 3-digit CSC.

## Visa Trusted Agent Protocol

Notes on setting up the demo store and verifier with the Visa Trusted Agent Protocol sample (https://github.com/visa/trusted-agent-protocol, covered by the Visa Developer terms). Do not copy the sample's code into this repository.
