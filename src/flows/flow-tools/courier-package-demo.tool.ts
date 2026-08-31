/** Matches {@link FlowToolExecutionContext} — local copy to avoid circular imports with the executor. */
interface CourierDemoToolContext {
  slots: Record<string, unknown>;
  companyId?: string;
  callSid?: string;
  phoneNumberTo?: string;
  phoneNumberFrom?: string;
  flowId?: string;
  language?: string;
}

function pickTracking(args: Record<string, unknown>, ctx: CourierDemoToolContext): string {
  const fromArgs =
    (typeof args.tracking_number === 'string' && args.tracking_number.trim()) ||
    (typeof args.reference === 'string' && args.reference.trim()) ||
    (typeof args.package_id === 'string' && args.package_id.trim());
  if (fromArgs) return fromArgs.trim();
  const s = ctx.slots.tracking_number ?? ctx.slots.reference ?? ctx.slots.package_id;
  return typeof s === 'string' ? s.trim() : '';
}

function randomPick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Demo-only flow tool: returns plausible random parcel metadata for voice/UI demos.
 * Register as executorKey `courier_package_demo`.
 */
export async function courierPackageDemoFlowToolHandler(
  args: Record<string, unknown>,
  ctx: CourierDemoToolContext,
): Promise<string> {
  const tracking = pickTracking(args, ctx);
  if (!tracking) {
    return JSON.stringify({
      ok: false,
      error: 'missing_tracking',
      message: 'Ask the caller for their tracking number or reference.',
    });
  }

  const carriers = [
    'SwiftParcel',
    'Metro Courier',
    'GlobeFreight Express',
    'North Route Logistics',
  ];
  const statuses = [
    'Out for delivery',
    'At local depot',
    'In transit',
    'Sorted at regional hub',
    'Departed origin facility',
    'Loaded onto delivery vehicle',
  ];
  const cities = ['Karachi', 'Lahore', 'Islamabad', 'Dubai', 'Singapore', 'London'];

  const carrier = randomPick(carriers);
  const status = randomPick(statuses);
  const origin = randomPick(cities);
  let destination = randomPick(cities);
  if (destination === origin) destination = randomPick(cities);

  const etaOptions = [
    'today between 2 PM and 6 PM',
    'tomorrow before noon',
    'within two business days',
    'Friday by end of day',
    'Monday morning before 10 AM',
  ];
  const estimated_delivery = randomPick(etaOptions);

  const serviceLevels = ['Standard', 'Express', 'Same-day (metro)', 'Economy'];
  const service_level = randomPick(serviceLevels);

  const scans = [
    `Departed ${origin} sorting centre`,
    `Arrived at ${destination} distribution hub`,
    'Passed outbound customs scan',
    'Received at local carrier depot',
    `Delivery scheduled — courier assigned for ${destination}`,
  ];

  const weight_kg = Math.round((2 + Math.random() * 18) * 10) / 10;

  const payload = {
    ok: true,
    demo: true,
    tracking_number: tracking.toUpperCase(),
    carrier,
    status,
    estimated_delivery,
    origin_hub: origin,
    destination_city: destination,
    service_level,
    last_scan: randomPick(scans),
    weight_kg,
    package_summary: `${carrier}: ${status}. ETA ${estimated_delivery}. Last update — ${randomPick(scans)}.`,
  };

  return JSON.stringify(payload);
}
