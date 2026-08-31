import type { MozoApiService } from '../../mozo/services/mozo-api.service';

/** Matches {@link FlowToolExecutionContext} — local copy to avoid circular imports with the executor. */
interface MozoOrderToolContext {
  slots: Record<string, unknown>;
  companyId?: string;
  callSid?: string;
  flowId?: string;
  language?: string;
}

export interface MozoMenuOption {
  /** The option's own article id (`article_option_article_id`) — Mozo models each option as its own article. */
  id: string;
  name: string;
  price: number;
}

export interface MozoMenuItem {
  id: string;
  name: string;
  /** Untranslated name as stored in Mozo (e.g. "koffie") — kept as a match fallback for a
   * guest who names the item in the venue's own language even mid-call in another language. */
  nativeName: string;
  description: string | null;
  price: number | null;
  vatPercentage: number | null;
  /** Modifiers/choices for this item (e.g. "with/without whipped cream"), each with its own price delta. */
  options: MozoMenuOption[];
}

export interface MozoOrderLineItem {
  item_name: string;
  quantity: number;
  article_id?: string | null;
  price?: number | null;
}

function slotStr(slots: Record<string, unknown>, key: string): string {
  const v = slots[key];
  return typeof v === 'string' ? v.trim() : '';
}

function slotQuantity(slots: Record<string, unknown>, key: string): number {
  const v = slots[key];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

interface ArticleTranslation {
  name: string | null;
  description: string | null;
}

/**
 * Builds an id -> translation lookup from `GET /v4/catalog/article/all/{venue}`'s response.
 * Confirmed real shape (venue 28, "MRWINSTON" test venue): each entry is
 * `{ article: { id, name, ... }, translations: { name: { en: "Coffee" }, description: { en: "latte" } } }`
 * — `translations` fields are `null` when nothing was translated for that article (options are
 * frequently untranslated even when the parent item is).
 */
function buildTranslationLookup(
  allMenu: unknown,
  language: string,
): Map<string, ArticleTranslation> {
  const lookup = new Map<string, ArticleTranslation>();
  const container =
    allMenu && typeof allMenu === 'object' ? (allMenu as Record<string, unknown>) : {};
  const rawList = Array.isArray(container.data) ? container.data : [];

  for (const raw of rawList as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const article = r.article as Record<string, unknown> | undefined;
    const id = article?.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;

    const translations = r.translations as Record<string, unknown> | undefined;
    const nameMap = translations?.name as Record<string, unknown> | null | undefined;
    const descMap = translations?.description as Record<string, unknown> | null | undefined;
    const nameValue = nameMap?.[language];
    const descValue = descMap?.[language];
    const name = typeof nameValue === 'string' ? nameValue : null;
    const description = typeof descValue === 'string' ? descValue : null;

    lookup.set(String(id), { name, description });
  }
  return lookup;
}

/**
 * Merges Mozo's two menu endpoints into a complete, presentable item list. Neither endpoint
 * alone has everything a call agent needs — confirmed against venue 28 ("MRWINSTON"), the
 * first real populated test venue found (venue 13 has an empty catalog):
 *
 * - `activeMenu` (`GET /v4/catalog/article/active/{venue}`): only orderable (status:1) items,
 *   each with `price`, `vat: {percentage}`, and inline `options` (id, article_option_article_id,
 *   name, price) — but names/descriptions are in the venue's native language only.
 * - `allMenu` (`GET /v4/catalog/article/all/{venue}`, optional): every article including each
 *   option as its own top-level entry, each with `translations.name[lang]` /
 *   `translations.description[lang]` — used here purely as a translation lookup, keyed by
 *   article id. Pass `undefined` to skip translation and just get native-language names.
 *
 * `preferredLanguage` (ISO 639-1, default "en") selects which translation to prefer; falls
 * back to the native name/description when no translation exists for that language or article.
 */
export function extractMozoMenuItems(
  activeMenu: unknown,
  allMenu?: unknown,
  preferredLanguage = 'en',
): MozoMenuItem[] {
  const translations = allMenu
    ? buildTranslationLookup(allMenu, preferredLanguage)
    : new Map<string, ArticleTranslation>();

  const container =
    activeMenu && typeof activeMenu === 'object' ? (activeMenu as Record<string, unknown>) : {};
  const rawList = Array.isArray(container.data) ? container.data : [];

  const items: MozoMenuItem[] = [];
  for (const raw of rawList as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const article = (raw as Record<string, unknown>).article as Record<string, unknown> | undefined;
    if (!article) continue;

    const idRaw = article.id;
    const nativeName = article.name;
    if (
      (typeof idRaw !== 'string' && typeof idRaw !== 'number') ||
      typeof nativeName !== 'string' ||
      nativeName.trim() === ''
    )
      continue;
    const id = String(idRaw);

    const translated = translations.get(id);
    const translatedName = translated?.name?.trim();
    const name = translatedName ?? nativeName.trim();

    const nativeDesc = typeof article.description === 'string' ? article.description.trim() : '';
    const translatedDesc = translated?.description?.trim();
    const description = translatedDesc ?? (nativeDesc ? nativeDesc : null);

    const price = typeof article.price === 'number' ? article.price : null;
    const vat = article.vat as Record<string, unknown> | undefined;
    const vatPercentage = typeof vat?.percentage === 'number' ? vat.percentage : null;

    const rawOptions = Array.isArray(article.options) ? article.options : [];
    const options: MozoMenuOption[] = [];
    for (const rawOption of rawOptions as unknown[]) {
      if (!rawOption || typeof rawOption !== 'object') continue;
      const o = rawOption as Record<string, unknown>;
      const optionArticleId = o.article_option_article_id ?? o.id;
      if (typeof optionArticleId !== 'string' && typeof optionArticleId !== 'number') continue;
      const optionId = String(optionArticleId);
      const optionNative = typeof o.name === 'string' ? o.name : '';
      const optionTranslated = translations.get(optionId);
      const optionTranslatedName = optionTranslated?.name?.trim();
      const optionName = optionTranslatedName ?? optionNative.trim();
      if (!optionName) continue;
      const optionPrice = typeof o.price === 'number' ? o.price : 0;
      options.push({ id: optionId, name: optionName, price: optionPrice });
    }

    items.push({
      id,
      name,
      nativeName: nativeName.trim(),
      description,
      price,
      vatPercentage,
      options,
    });
  }
  return items;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

/** Space-collapsed form, so "cheese burger" (ASR-spaced) still matches "Cheeseburger". */
function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Both the translated and native-language names — a guest may say either mid-call. */
function candidateNames(item: MozoMenuItem): string[] {
  return item.nativeName && item.nativeName !== item.name
    ? [item.name, item.nativeName]
    : [item.name];
}

/**
 * Deliberately simple — exact match, then space-collapsed match (handles ASR splitting a
 * compound word like "Cheeseburger" into "cheese burger"), then substring either direction,
 * then word overlap. Checks both the translated and native-language name at every tier.
 * Mirrors the plain substring-match style already used for flow `slot_definitions`
 * aliases/choices (see `slot-extraction.util.ts`'s `matchAliases`/`matchChoices`) rather than
 * pulling in a fuzzy-matching library for what's still an unverified data source.
 */
export function findMenuItemMatch(items: MozoMenuItem[], spokenName: string): MozoMenuItem | null {
  const target = normalizeForMatch(spokenName);
  if (!target) return null;

  const exact = items.find(i => candidateNames(i).some(n => normalizeForMatch(n) === target));
  if (exact) return exact;

  const targetCollapsed = collapseSpaces(target);
  const byCollapsed = items.find(i =>
    candidateNames(i).some(n => collapseSpaces(normalizeForMatch(n)) === targetCollapsed),
  );
  if (byCollapsed) return byCollapsed;

  const bySubstring = [...items]
    .sort((a, b) => b.name.length - a.name.length)
    .find(i =>
      candidateNames(i).some(rawName => {
        const n = normalizeForMatch(rawName);
        return n.includes(target) || target.includes(n);
      }),
    );
  if (bySubstring) return bySubstring;

  const targetWords = new Set(target.split(' ').filter(w => w.length > 2));
  if (targetWords.size === 0) return null;
  let best: { item: MozoMenuItem; overlap: number } | null = null;
  for (const item of items) {
    const nameWords = candidateNames(item).flatMap(n =>
      normalizeForMatch(n)
        .split(' ')
        .filter(w => w.length > 2),
    );
    const overlap = nameWords.filter(w => targetWords.has(w)).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) {
      best = { item, overlap };
    }
  }
  return best?.item ?? null;
}

export function parseMozoOrderItems(slots: Record<string, unknown>): MozoOrderLineItem[] {
  const raw = slots.mozo_order_items;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (x): x is MozoOrderLineItem =>
            x != null &&
            typeof x === 'object' &&
            typeof (x as MozoOrderLineItem).item_name === 'string' &&
            (x as MozoOrderLineItem).item_name.trim() !== '',
        );
      }
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(raw)) {
    return raw.filter(
      (x): x is MozoOrderLineItem =>
        x != null &&
        typeof x === 'object' &&
        typeof (x as MozoOrderLineItem).item_name === 'string' &&
        (x as MozoOrderLineItem).item_name.trim() !== '',
    );
  }
  return [];
}

function formatOrderSummary(items: MozoOrderLineItem[]): string {
  return items
    .map(i => (i.quantity > 1 ? `${String(i.quantity)}x ${i.item_name}` : i.item_name))
    .join(', ');
}

/** " for a total of $23.50", or "" when any line item's price is unknown — never state a fabricated total. */
function formatOrderTotalSuffix(items: MozoOrderLineItem[]): string {
  if (items.length === 0) return '';
  const allPriced = items.every(i => typeof i.price === 'number');
  if (!allPriced) return '';
  const total = items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0);
  return ` for a total of $${total.toFixed(2)}`;
}

/**
 * Fetches and merges both menu endpoints (see `extractMozoMenuItems`'s docblock) — the one
 * call site both `mozo_get_menu` and `mozo_append_order_item` share.
 */
async function fetchMergedMenu(
  mozoApiService: MozoApiService,
  language: string,
): Promise<MozoMenuItem[]> {
  const [activeMenu, allMenu] = await Promise.all([
    mozoApiService.getActiveMenu(),
    mozoApiService.getMenu().catch(() => undefined), // translations are a nice-to-have, not required
  ]);
  return extractMozoMenuItems(activeMenu, allMenu, language);
}

/**
 * Fetches the venue's live Mozo menu — for the agent to answer "what do you have" / "how
 * much is X" naturally (via tool-augmented chat on any prompt-type conversation node, see
 * `ConversationFlowToolExecutorService.runToolAugmentedChat`), and so
 * `mozo_append_order_item` can validate a spoken item against real articles. No caching:
 * always re-fetches — call volume here is at most two calls per guest turn, and Mozo doesn't
 * document a cache-invalidation signal for menu changes.
 * Register as executorKey "mozo_get_menu".
 */
export function createMozoGetMenuFlowToolHandler(mozoApiService: MozoApiService) {
  return async (_args: Record<string, unknown>, ctx: MozoOrderToolContext): Promise<string> => {
    try {
      const items = await fetchMergedMenu(mozoApiService, ctx.language ?? 'en');
      return JSON.stringify({
        ok: true,
        items,
        items_count: items.length,
        menu_configured: items.length > 0,
        note:
          items.length === 0
            ? 'No menu items are currently configured for this venue in Mozo. Do not invent items — tell the guest you cannot look up specific dishes or prices right now, and take their request as free text for staff to confirm.'
            : 'Items may have "options" (e.g. with/without whipped cream) with their own price — mention relevant ones when helpful, never invent options that are not listed.',
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: 'menu_fetch_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * After each "item + quantity" turn, resolves the spoken item name against Mozo's live menu
 * (when one is configured for this venue) before accepting it — so `mozo_order_items` carries
 * a real `article_id` + `price`, not just free text, ready for whatever `createOrder()`
 * eventually sends to Mozo. Falls back to accepting the raw name when Mozo has no menu
 * configured (true for the only real test venue available) or the menu fetch fails —
 * flagged via `menu_configured`/`menu_checked` so the agent can caveat rather than confirm
 * something it never actually verified. Pushes to `mozo_order_items` and clears the per-item
 * slots so the next turn starts fresh. Register as executorKey "mozo_append_order_item".
 */
export function createMozoAppendOrderItemFlowToolHandler(mozoApiService: MozoApiService) {
  return async (_args: Record<string, unknown>, ctx: MozoOrderToolContext): Promise<string> => {
    const itemName = slotStr(ctx.slots, 'item_name');

    if (!itemName) {
      return JSON.stringify({
        ok: false,
        error: 'incomplete_line_item',
        message: 'Missing item name for this order line',
        missing: ['item_name'],
        suggested_node_id: 'ask-item',
      });
    }

    const quantity = slotQuantity(ctx.slots, 'quantity');
    const items = parseMozoOrderItems(ctx.slots);

    let menuItems: MozoMenuItem[] = [];
    let menuChecked = true;
    try {
      menuItems = await fetchMergedMenu(mozoApiService, ctx.language ?? 'en');
    } catch {
      menuChecked = false; // Mozo unreachable — degrade to accepting the raw name below
    }

    let matchedOptions: MozoMenuOption[] = [];
    if (menuItems.length > 0) {
      const match = findMenuItemMatch(menuItems, itemName);
      if (!match) {
        const sample = menuItems
          .slice(0, 5)
          .map(i => i.name)
          .join(', ');
        return JSON.stringify({
          ok: false,
          error: 'item_not_on_menu',
          message: `"${itemName}" doesn't match anything on the menu. Some available items: ${sample}.`,
          suggested_node_id: 'ask-item',
        });
      }
      items.push({ item_name: match.name, quantity, article_id: match.id, price: match.price });
      matchedOptions = match.options;
    } else {
      items.push({ item_name: itemName, quantity, article_id: null, price: null });
    }

    return JSON.stringify({
      ok: true,
      mozo_order_items: items,
      items_count: items.length,
      order_summary_so_far: formatOrderSummary(items),
      order_total_suffix: formatOrderTotalSuffix(items),
      menu_configured: menuItems.length > 0,
      menu_checked: menuChecked,
      // Available modifiers for the item just added (e.g. with/without whipped cream) — not
      // yet captured onto the order line if chosen; mention them if relevant, don't invent any.
      available_options: matchedOptions,
      item_name: '',
      quantity: '',
    });
  };
}

/**
 * Submits the accumulated, menu-resolved order to Mozo (`MozoApiService.createOrder` — see
 * its docblock: the underlying multi-step Mozo checkout flow is deliberately not implemented
 * yet, so this always throws with a message pointing at `src/mozo/README.md`'s "Order
 * creation" section; that's a known, temporary gap in the Mozo API-linking layer, not this
 * tool). Everything upstream of that call — item resolution, running total, confirmation —
 * is complete and ready for whenever `createOrder()` is wired up for real.
 * Register as executorKey "mozo_create_order" — needs MozoApiService injected into the
 * executor, so this is a factory, not a plain handler function like the other flow tools.
 */
export function createMozoSubmitOrderFlowToolHandler(mozoApiService: MozoApiService) {
  return async (_args: Record<string, unknown>, ctx: MozoOrderToolContext): Promise<string> => {
    let items = parseMozoOrderItems(ctx.slots);

    const pendingItem = slotStr(ctx.slots, 'item_name');
    if (items.length === 0 && pendingItem) {
      items = [
        {
          item_name: pendingItem,
          quantity: slotQuantity(ctx.slots, 'quantity'),
          article_id: null,
          price: null,
        },
      ];
    }

    if (items.length === 0) {
      return JSON.stringify({
        ok: false,
        error: 'incomplete_order',
        message: 'No items on the order yet — ask what the guest would like.',
        missing: ['mozo_order_items'],
        suggested_node_id: 'ask-item',
      });
    }

    try {
      const result = await mozoApiService.createOrder({
        items: items.map(i => ({
          article_id: i.article_id ?? null,
          name: i.item_name,
          quantity: i.quantity,
          price: i.price ?? null,
        })),
      });
      const data =
        result && typeof result === 'object' && 'data' in (result as Record<string, unknown>)
          ? ((result as Record<string, unknown>).data as Record<string, unknown> | undefined)
          : (result as Record<string, unknown> | undefined);

      return JSON.stringify({
        ok: true,
        mozo_order_items: items,
        order_summary: formatOrderSummary(items),
        mozo_order_session_id: data?.order_session_id ?? null,
        mozo_order_status: data?.status ?? null,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: 'mozo_order_failed',
        message: err instanceof Error ? err.message : String(err),
        suggested_node_id: 'order-failed',
      });
    }
  };
}
