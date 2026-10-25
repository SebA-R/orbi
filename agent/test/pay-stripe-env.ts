// Import this first: origins.ts reads CLEARCART_PAY_ORIGINS once, when it
// loads. Stripe's hosted test checkout as the pay site.
export const STRIPE_SITE = "https://checkout.stripe.com";
process.env.CLEARCART_PAY_ORIGINS = STRIPE_SITE;
