// Fixed category taxonomy and item kinds (plan §6.2). Policy compares these codes, never free
// text, so an agent cannot talk its way into a category. Codes are "parent.leaf": cart items
// always carry a leaf; a Writ may allow a whole parent or individual leaves.
import { z } from "zod";

export const CATEGORY_PARENTS = [
  "arts_crafts",
  "home_kitchen",
  "home_decor",
  "office",
  "stationery",
  "books_media",
  "toys_games",
  "apparel",
  "beauty",
  "grocery",
  "pet",
  "garden",
  "sports",
  "electronics",
  "party",
  "services",
] as const;
export type CategoryParent = (typeof CATEGORY_PARENTS)[number];

export const CATEGORY_LEAVES = [
  "arts_crafts.pottery_ceramics",
  "arts_crafts.craft_supplies",
  "arts_crafts.art_prints",
  "home_kitchen.drinkware",
  "home_kitchen.coffee_tea",
  "home_kitchen.tableware",
  "home_kitchen.cookware",
  "home_kitchen.kitchen_tools",
  "home_decor.vases_planters",
  "home_decor.candles_fragrance",
  "home_decor.wall_decor",
  "home_decor.textiles",
  "office.paper",
  "office.ink_toner",
  "office.supplies",
  "stationery.notebooks_journals",
  "stationery.pens_pencils",
  "stationery.cards_gift_wrap",
  "books_media.books",
  "books_media.music_movies",
  "books_media.digital_downloads",
  "toys_games.toys",
  "toys_games.games_puzzles",
  "apparel.clothing",
  "apparel.shoes",
  "apparel.bags_accessories",
  "apparel.jewelry_watches",
  "beauty.skincare",
  "beauty.makeup",
  "beauty.bath_body",
  "grocery.pantry_snacks",
  "grocery.beverages",
  "grocery.gift_baskets",
  "pet.supplies",
  "pet.food",
  "garden.plants_seeds",
  "garden.tools_outdoor",
  "sports.fitness",
  "sports.outdoor_recreation",
  "electronics.accessories",
  "electronics.audio",
  "party.supplies",
  "services.protection_plans",
  "services.subscriptions",
  "services.gift_cards",
] as const satisfies readonly `${CategoryParent}.${string}`[];
export type CategoryLeaf = (typeof CATEGORY_LEAVES)[number];
export type CategorySelector = CategoryParent | CategoryLeaf;

export const CATEGORY_PARENT_LABELS: Readonly<Record<CategoryParent, string>> = {
  arts_crafts: "Arts & crafts",
  home_kitchen: "Home & kitchen",
  home_decor: "Home decor",
  office: "Office",
  stationery: "Stationery & paper goods",
  books_media: "Books & media",
  toys_games: "Toys & games",
  apparel: "Apparel & accessories",
  beauty: "Beauty & personal care",
  grocery: "Grocery & gourmet",
  pet: "Pet supplies",
  garden: "Garden & outdoor",
  sports: "Sports & fitness",
  electronics: "Electronics",
  party: "Party & celebrations",
  services: "Services & stored value",
};

export const CATEGORY_LEAF_LABELS: Readonly<Record<CategoryLeaf, string>> = {
  "arts_crafts.pottery_ceramics": "Pottery & ceramics",
  "arts_crafts.craft_supplies": "Craft supplies & kits",
  "arts_crafts.art_prints": "Art & prints",
  "home_kitchen.drinkware": "Mugs, cups & drinkware",
  "home_kitchen.coffee_tea": "Coffee & tea gear",
  "home_kitchen.tableware": "Plates, bowls & serveware",
  "home_kitchen.cookware": "Cookware & bakeware",
  "home_kitchen.kitchen_tools": "Kitchen tools & gadgets",
  "home_decor.vases_planters": "Vases & planters",
  "home_decor.candles_fragrance": "Candles & home fragrance",
  "home_decor.wall_decor": "Wall decor & frames",
  "home_decor.textiles": "Throws, pillows & textiles",
  "office.paper": "Printer & copy paper",
  "office.ink_toner": "Ink & toner",
  "office.supplies": "Office supplies",
  "stationery.notebooks_journals": "Notebooks & journals",
  "stationery.pens_pencils": "Pens & pencils",
  "stationery.cards_gift_wrap": "Greeting cards & gift wrap",
  "books_media.books": "Books",
  "books_media.music_movies": "Music & movies",
  "books_media.digital_downloads": "E-books, digital media & software",
  "toys_games.toys": "Toys",
  "toys_games.games_puzzles": "Games & puzzles",
  "apparel.clothing": "Clothing",
  "apparel.shoes": "Shoes",
  "apparel.bags_accessories": "Bags & accessories",
  "apparel.jewelry_watches": "Jewelry & watches",
  "beauty.skincare": "Skincare",
  "beauty.makeup": "Makeup",
  "beauty.bath_body": "Bath & body",
  "grocery.pantry_snacks": "Pantry & snacks",
  "grocery.beverages": "Coffee, tea & beverages",
  "grocery.gift_baskets": "Gourmet gifts & baskets",
  "pet.supplies": "Pet supplies",
  "pet.food": "Pet food & treats",
  "garden.plants_seeds": "Plants & seeds",
  "garden.tools_outdoor": "Garden tools & outdoor living",
  "sports.fitness": "Fitness equipment",
  "sports.outdoor_recreation": "Outdoor recreation",
  "electronics.accessories": "Electronics accessories",
  "electronics.audio": "Headphones & speakers",
  "party.supplies": "Party supplies & decorations",
  "services.protection_plans": "Protection plans & warranties",
  "services.subscriptions": "Subscriptions & memberships",
  "services.gift_cards": "Gift cards & stored value",
};

export const CategoryParentSchema = z.enum(CATEGORY_PARENTS);
/** Cart items must name a leaf: a parent is too coarse to check an item against. */
export const CategoryLeafSchema = z.enum(CATEGORY_LEAVES);
/** What a Writ may allow: a whole parent (every leaf under it) or a single leaf. */
export const CategorySelectorSchema = z.enum([...CATEGORY_PARENTS, ...CATEGORY_LEAVES]);

const PARENT_SET: ReadonlySet<string> = new Set(CATEGORY_PARENTS);
const LEAF_SET: ReadonlySet<string> = new Set(CATEGORY_LEAVES);

export function isCategoryParent(code: string): code is CategoryParent {
  return PARENT_SET.has(code);
}

export function isCategoryLeaf(code: string): code is CategoryLeaf {
  return LEAF_SET.has(code);
}

export function categoryParentOf(leaf: CategoryLeaf): CategoryParent {
  return leaf.slice(0, leaf.indexOf(".")) as CategoryParent;
}

export function categoryLeavesOf(parent: CategoryParent): CategoryLeaf[] {
  return CATEGORY_LEAVES.filter((leaf) => categoryParentOf(leaf) === parent);
}

/**
 * True when `leaf` is allowed by the selectors, exactly or via its parent. Takes a plain string
 * so a value that skipped schema validation fails closed instead of matching by accident.
 */
export function categoryAllowed(selectors: readonly CategorySelector[], leaf: string): boolean {
  if (!isCategoryLeaf(leaf)) return false;
  const parent = categoryParentOf(leaf);
  return selectors.some((selector) => selector === leaf || selector === parent);
}

export function categoryLabel(code: CategorySelector): string {
  if (isCategoryLeaf(code)) return CATEGORY_LEAF_LABELS[code];
  if (isCategoryParent(code)) return CATEGORY_PARENT_LABELS[code];
  throw new TypeError(`unknown category code: ${JSON.stringify(code)}`);
}

/** What an item is, independent of its category. Only plain goods can never be denied. */
export const ITEM_KINDS = [
  "goods",
  "gift_card",
  "protection_plan",
  "subscription",
  "digital_goods",
  "money_transfer",
  "crypto",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ItemKindSchema = z.enum(ITEM_KINDS);

/** Plan §6.2 deny-kinds: every kind except plain goods. Draft Writs deny all of them by default. */
export const DENIABLE_KINDS = [
  "gift_card",
  "protection_plan",
  "subscription",
  "digital_goods",
  "money_transfer",
  "crypto",
] as const satisfies readonly Exclude<ItemKind, "goods">[];
export type DeniableKind = (typeof DENIABLE_KINDS)[number];
export const DeniableKindSchema = z.enum(DENIABLE_KINDS);

export const ITEM_KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  goods: "Physical goods",
  gift_card: "Gift cards",
  protection_plan: "Protection plans & warranties",
  subscription: "Subscriptions",
  digital_goods: "Digital goods",
  money_transfer: "Money transfers",
  crypto: "Crypto",
};

const KIND_SET: ReadonlySet<string> = new Set(ITEM_KINDS);

/** True when `kind` is denied. An unknown kind counts as denied (fail closed). */
export function kindDenied(denyKinds: readonly DeniableKind[], kind: string): boolean {
  if (!KIND_SET.has(kind)) return true;
  return (denyKinds as readonly string[]).includes(kind);
}
