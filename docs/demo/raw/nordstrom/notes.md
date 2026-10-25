# Nordstrom (www.nordstrom.com), run of 2026-10-24

AI-to-AI simulation: the shopper is an AI playing a blind user. The run stopped at the bag page, and nothing was purchased.

**Task given to the shopper:** find women's white Nike Air Force 1 '07 sneakers in size 8, hear the price and the rating, and have them added to the bag.

**What happened (t = seconds since the session opened):**
- 1.3 s: the shopper asks. Clearcart opens its own new tab (line 1 is an aside about this) and searches Nordstrom.
- 6 to 44 s: Clearcart runs two searches, opens and backs out of a listing, then settles on the product page for the women's Nike Air Force 1 '07 Basketball Sneaker (`/s/nike-air-force-1-07-basketball-sneaker-women/9147830`).
- 44 to 57 s: it checks the size list, then reports **$115, about 4.5 out of 5 stars from 799 reviews, size 8 available**, and says it hasn't added anything yet.
- 65 s: the shopper asks it to add the shoes. Clearcart selects size 8, adds them to the bag, and opens `/shopping-bag`.
- 85 s: it reads back the bag: $115, free shipping, estimated total $124.92 with tax, checkout not started. (The page labels it "Guest Shopping Bag", so no login was involved.)
- 94 s onward: thanks and a goodbye loop (marked `tail`).

**Blocks:** none. Nordstrom is known for strict bot protection, but nothing appeared in this run, probably because Clearcart drives the user's real Chrome profile.

**Cart left in the browser:** the Air Force 1 '07 (size 8 M, white) is still in the Nordstrom guest bag in the user's Chrome profile.
