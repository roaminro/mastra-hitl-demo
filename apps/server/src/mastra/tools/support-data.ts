// Mock CRM data for the customer support demo.

export interface Order {
  orderId: string;
  date: string;
  item: string;
  amountUsd: number;
  status: 'delivered' | 'shipped' | 'processing' | 'refunded';
}

export interface Customer {
  customerId: string;
  name: string;
  email: string;
  plan: 'free' | 'pro' | 'enterprise';
  since: string;
  orders: Order[];
}

export const customers: Customer[] = [
  {
    customerId: 'cust_001',
    name: 'Dana Reyes',
    email: 'dana@example.com',
    plan: 'pro',
    since: '2024-03-12',
    orders: [
      { orderId: 'ord_1001', date: '2026-05-28', item: 'Pro plan (annual)', amountUsd: 240, status: 'delivered' },
      { orderId: 'ord_1002', date: '2026-06-02', item: 'Extra seat add-on', amountUsd: 60, status: 'delivered' },
    ],
  },
  {
    customerId: 'cust_002',
    name: 'Sam Okafor',
    email: 'sam@example.com',
    plan: 'enterprise',
    since: '2023-11-01',
    orders: [
      { orderId: 'ord_2001', date: '2026-04-15', item: 'Enterprise plan (monthly)', amountUsd: 900, status: 'delivered' },
      { orderId: 'ord_2002', date: '2026-05-15', item: 'Enterprise plan (monthly)', amountUsd: 900, status: 'delivered' },
      { orderId: 'ord_2003', date: '2026-06-05', item: 'Onboarding workshop', amountUsd: 1500, status: 'processing' },
    ],
  },
];

export interface Refund {
  refundId: string;
  orderId: string;
  customerId: string;
  amountUsd: number;
  reason: string;
  issuedAt: string;
}

// In-memory refund ledger (resets on server restart — fine for a demo).
export const refunds: Refund[] = [];
