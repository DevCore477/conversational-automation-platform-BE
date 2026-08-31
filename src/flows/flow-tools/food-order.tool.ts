/** Matches {@link FlowToolExecutionContext} — local copy to avoid circular imports with the executor. */
interface FoodOrderToolContext {
  slots: Record<string, unknown>;
  companyId?: string;
  callSid?: string;
  phoneNumberTo?: string;
  phoneNumberFrom?: string;
  flowId?: string;
  language?: string;
}

export interface OrderLineItem {
  product: string;
  sauce_1: string;
  sauce_2: string;
  addons: string;
}

function slotStr(slots: Record<string, unknown>, key: string): string {
  const v = slots[key];
  return typeof v === 'string' ? v.trim() : '';
}

function isNone(value: string): boolean {
  const v = value.toLowerCase().trim();
  return v === '' || v === 'none' || v === 'no' || v === 'n/a';
}

export function parseOrderItems(slots: Record<string, unknown>): OrderLineItem[] {
  const raw = slots.order_items;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (x): x is OrderLineItem =>
            x != null &&
            typeof x === 'object' &&
            typeof (x as OrderLineItem).product === 'string' &&
            (x as OrderLineItem).product.trim() !== '',
        );
      }
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(raw)) {
    return raw.filter(
      (x): x is OrderLineItem =>
        x != null && typeof x === 'object' && typeof x.product === 'string' && x.product.trim() !== '',
    );
  }
  return [];
}

export function formatLineItem(item: OrderLineItem): string {
  let line = `${item.product} with ${item.sauce_1} and ${item.sauce_2}`;
  if (!isNone(item.addons)) line += `, add-ons ${item.addons}`;
  return line;
}

function normalizeDeliveryType(raw: string): string {
  const t = raw.toLowerCase().trim();
  if (/\b(deliver|delivery|home)\b/.test(t) && !/\bpick/i.test(t)) return 'delivery';
  if (/\b(pick\s*up|pickup|collection|takeaway|take\s*away)\b/.test(t)) return 'pickup';
  return t;
}

/** Short summary for voice confirm — skips none/empty drink and fries. */
export function buildVoiceOrderSummary(
  items: OrderLineItem[],
  drink: string,
  fries: string,
  deliveryType: string,
  deliveryAddress: string,
): string {
  if (items.length === 0) return '';

  const itemLines =
    items.length === 1
      ? [formatLineItem(items[0])]
      : items.map((it, i) => `item ${i + 1}, ${formatLineItem(it)}`);

  const extras: string[] = [];
  if (!isNone(drink)) extras.push(drink);
  if (!isNone(fries)) extras.push(fries);

  const main = itemLines.join('; ');
  let summary = main;
  if (extras.length > 0) summary += `. Also ${extras.join(' and ')}`;

  const fulfillment = normalizeDeliveryType(deliveryType);
  if (fulfillment === 'delivery' && deliveryAddress.trim()) {
    summary += `. Delivery to ${deliveryAddress.trim()}`;
  } else if (fulfillment === 'pickup') {
    summary += '. Pickup';
  }

  return `${summary}.`;
}

/**
 * After each line item (product + sauces + add-ons), push to order_items and clear per-item slots.
 */
export async function appendOrderItemFlowToolHandler(
  _args: Record<string, unknown>,
  ctx: FoodOrderToolContext,
): Promise<string> {
  const product = slotStr(ctx.slots, 'product');
  const sauce1 = slotStr(ctx.slots, 'sauce_1');
  const sauce2 = slotStr(ctx.slots, 'sauce_2');
  const addons = slotStr(ctx.slots, 'addons') || 'none';

  const missing: string[] = [];
  if (!product) missing.push('product');
  if (!sauce1) missing.push('sauce_1');
  if (!sauce2) missing.push('sauce_2');

  if (missing.length > 0) {
    const retryBySlot: Record<string, string> = {
      product: 'ask-product',
      sauce_1: 'ask-sauce-1',
      sauce_2: 'ask-sauce-2',
      addons: 'ask-addons',
    };
    const firstMissing = missing[0];
    return JSON.stringify({
      ok: false,
      error: 'incomplete_line_item',
      message: `Missing for this item: ${missing.join(', ')}`,
      missing,
      suggested_node_id: retryBySlot[firstMissing] ?? 'ask-product',
    });
  }

  const items = parseOrderItems(ctx.slots);
  items.push({ product, sauce_1: sauce1, sauce_2: sauce2, addons });

  return JSON.stringify({
    ok: true,
    order_items: items,
    items_count: items.length,
    product: '',
    sauce_1: '',
    sauce_2: '',
    addons: '',
  });
}

/**
 * Validate full order and return a single concise order_summary for TTS.
 */
export async function submitFoodOrderFlowToolHandler(
  _args: Record<string, unknown>,
  ctx: FoodOrderToolContext,
): Promise<string> {
  let items = parseOrderItems(ctx.slots);

  const pendingProduct = slotStr(ctx.slots, 'product');
  if (items.length === 0 && pendingProduct) {
    items = [
      {
        product: pendingProduct,
        sauce_1: slotStr(ctx.slots, 'sauce_1'),
        sauce_2: slotStr(ctx.slots, 'sauce_2'),
        addons: slotStr(ctx.slots, 'addons') || 'none',
      },
    ];
  }

  const drink = slotStr(ctx.slots, 'drink') || 'none';
  const fries = slotStr(ctx.slots, 'fries') || 'none';
  const deliveryType = normalizeDeliveryType(slotStr(ctx.slots, 'delivery_type'));
  const deliveryAddress = slotStr(ctx.slots, 'delivery_address');

  const missing: string[] = [];
  if (items.length === 0) missing.push('order_items');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.product) missing.push(`item_${i + 1}_product`);
    if (!it.sauce_1) missing.push(`item_${i + 1}_sauce_1`);
    if (!it.sauce_2) missing.push(`item_${i + 1}_sauce_2`);
  }
  if (!deliveryType) missing.push('delivery_type');
  if (deliveryType === 'delivery' && !deliveryAddress) missing.push('delivery_address');

  if (missing.length > 0) {
    return JSON.stringify({
      ok: false,
      error: 'incomplete_order',
      message: `Still need: ${missing.join(', ')}`,
      missing,
    });
  }

  const order_summary = buildVoiceOrderSummary(
    items,
    drink,
    fries,
    deliveryType,
    deliveryAddress,
  );
  const order_id = `ORD-${Date.now().toString(36).toUpperCase()}`;

  return JSON.stringify({
    ok: true,
    order_items: items,
    items_count: items.length,
    drink: isNone(drink) ? 'none' : drink,
    fries: isNone(fries) ? 'none' : fries,
    delivery_type: deliveryType,
    delivery_address: deliveryType === 'delivery' ? deliveryAddress : '',
    order_summary,
    order_id,
  });
}
