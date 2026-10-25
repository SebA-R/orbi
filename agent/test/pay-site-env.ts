// Import this first in a test that needs a pay site: origins.ts reads
// CLEARCART_PAY_ORIGINS once, when it loads. Each test file runs in its
// own process, so this stays in the file that imports it.
export const PAY_SITE = "https://shop.example";
process.env.CLEARCART_PAY_ORIGINS = PAY_SITE;
