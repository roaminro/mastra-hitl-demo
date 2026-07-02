// Deterministic mock analytics dataset for the code mode demo.
//
// Everything is generated with a seeded PRNG so the data is identical on
// every run — tests can compute expected aggregates from these arrays and
// assert the sandbox-generated code got the math right.

export interface AnalyticsAccount {
  customerId: string;
  name: string;
  region: 'na' | 'emea' | 'apac' | 'latam';
  plan: 'free' | 'pro' | 'enterprise';
  signupDate: string;
}

export interface AnalyticsTransaction {
  txnId: string;
  customerId: string;
  /** Amount in cents to keep aggregation math exact */
  amountCents: number;
  category: 'subscription' | 'usage' | 'addon' | 'services';
  status: 'paid' | 'refunded' | 'failed';
  date: string; // YYYY-MM-DD, all in 2026
}

// Small deterministic LCG (numerical recipes constants).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const REGIONS: AnalyticsAccount['region'][] = ['na', 'emea', 'apac', 'latam'];
const PLANS: AnalyticsAccount['plan'][] = ['free', 'pro', 'enterprise'];
const CATEGORIES: AnalyticsTransaction['category'][] = [
  'subscription',
  'usage',
  'addon',
  'services',
];

const FIRST = ['Ava', 'Ben', 'Chloe', 'Dev', 'Elif', 'Femi', 'Gita', 'Hugo', 'Ines', 'Jonas'];
const LAST = ['Ito', 'Khan', 'Lopez', 'Meyer', 'Novak', 'Okafor', 'Pham', 'Quinn', 'Reyes', 'Sato'];

function generateAccounts(count: number): AnalyticsAccount[] {
  const rng = makeRng(42);
  return Array.from({ length: count }, (_, i) => {
    const first = FIRST[Math.floor(rng() * FIRST.length)]!;
    const last = LAST[Math.floor(rng() * LAST.length)]!;
    const month = 1 + Math.floor(rng() * 12);
    const day = 1 + Math.floor(rng() * 28);
    return {
      customerId: `acct_${String(i + 1).padStart(3, '0')}`,
      name: `${first} ${last}`,
      region: REGIONS[Math.floor(rng() * REGIONS.length)]!,
      plan: PLANS[Math.floor(rng() * PLANS.length)]!,
      signupDate: `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  });
}

function generateTransactions(
  accounts: AnalyticsAccount[],
  count: number,
): AnalyticsTransaction[] {
  const rng = makeRng(4242);
  return Array.from({ length: count }, (_, i) => {
    const account = accounts[Math.floor(rng() * accounts.length)]!;
    const month = 1 + Math.floor(rng() * 6); // H1 2026
    const day = 1 + Math.floor(rng() * 28);
    const roll = rng();
    return {
      txnId: `txn_${String(i + 1).padStart(4, '0')}`,
      customerId: account.customerId,
      amountCents: 500 + Math.floor(rng() * 99500), // $5.00 – $1000.00
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)]!,
      status: roll < 0.8 ? 'paid' : roll < 0.92 ? 'refunded' : 'failed',
      date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  });
}

export const analyticsAccounts: AnalyticsAccount[] = generateAccounts(40);
export const analyticsTransactions: AnalyticsTransaction[] =
  generateTransactions(analyticsAccounts, 500);
