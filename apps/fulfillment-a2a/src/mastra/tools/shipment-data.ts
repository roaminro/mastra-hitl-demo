export interface ShipmentEvent {
  at: string;
  location: string;
  description: string;
}

export interface Shipment {
  orderId: string;
  trackingNumber: string;
  carrier: string;
  status: 'in_transit' | 'delayed' | 'delivered';
  estimatedDelivery: string;
  delayReason?: string;
  events: ShipmentEvent[];
}

export const shipments: Shipment[] = [
  {
    orderId: 'ord_1003',
    trackingNumber: 'PFX-883104',
    carrier: 'ParcelFox',
    status: 'delayed',
    estimatedDelivery: '2026-07-17',
    delayReason: 'Weather disruption at the regional sorting hub',
    events: [
      {
        at: '2026-07-12T09:14:00Z',
        location: 'Austin, TX',
        description: 'Shipment picked up',
      },
      {
        at: '2026-07-13T03:42:00Z',
        location: 'Dallas, TX',
        description: 'Arrived at regional sorting hub',
      },
      {
        at: '2026-07-14T06:20:00Z',
        location: 'Dallas, TX',
        description: 'Delivery delayed by severe weather',
      },
    ],
  },
];

export const investigations = new Map<
  string,
  { caseId: string; orderId: string; openedAt: string; nextUpdateBy: string }
>();
