import { describe, expect, it } from "vitest";
import {
  CATEGORY_LEAF_LABELS,
  CATEGORY_LEAVES,
  CATEGORY_PARENT_LABELS,
  CATEGORY_PARENTS,
  categoryAllowed,
  categoryLabel,
  categoryLeavesOf,
  categoryParentOf,
  CategoryLeafSchema,
  CategorySelectorSchema,
  DENIABLE_KINDS,
  DeniableKindSchema,
  ITEM_KIND_LABELS,
  ITEM_KINDS,
  ItemKindSchema,
  kindDenied,
  type CategorySelector,
} from "../src/index";

describe("category taxonomy", () => {
  it("is a fixed list of about 40 lowercase two-level codes", () => {
    expect(CATEGORY_LEAVES.length).toBeGreaterThanOrEqual(35);
    expect(CATEGORY_LEAVES.length).toBeLessThanOrEqual(50);
    expect(new Set(CATEGORY_LEAVES).size).toBe(CATEGORY_LEAVES.length);
    expect(new Set(CATEGORY_PARENTS).size).toBe(CATEGORY_PARENTS.length);
    for (const leaf of CATEGORY_LEAVES) {
      expect(leaf).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      expect(CATEGORY_PARENTS).toContain(categoryParentOf(leaf));
    }
  });

  it("gives every parent at least one leaf and every code a label", () => {
    for (const parent of CATEGORY_PARENTS) {
      expect(categoryLeavesOf(parent).length).toBeGreaterThan(0);
      expect(CATEGORY_PARENT_LABELS[parent].length).toBeGreaterThan(0);
    }
    for (const leaf of CATEGORY_LEAVES) expect(CATEGORY_LEAF_LABELS[leaf].length).toBeGreaterThan(0);
    expect(Object.keys(CATEGORY_LEAF_LABELS).sort()).toEqual([...CATEGORY_LEAVES].sort());
  });

  it("covers the hero and the Office Writ", () => {
    for (const code of [
      "arts_crafts.pottery_ceramics",
      "home_kitchen.drinkware",
      "home_kitchen.coffee_tea",
      "home_decor.vases_planters",
      "services.protection_plans",
      "office.paper",
      "office.ink_toner",
      "office.supplies",
    ]) {
      expect(CategoryLeafSchema.safeParse(code).success).toBe(true);
    }
    expect(categoryLeavesOf("office")).toEqual(["office.paper", "office.ink_toner", "office.supplies"]);
  });

  it("requires leaves on items but lets a Writ select parents", () => {
    expect(CategoryLeafSchema.safeParse("home_kitchen").success).toBe(false);
    expect(CategorySelectorSchema.safeParse("home_kitchen").success).toBe(true);
    expect(CategorySelectorSchema.safeParse("home_kitchen.drinkware").success).toBe(true);
    expect(CategorySelectorSchema.safeParse("pottery").success).toBe(false);
    expect(CategorySelectorSchema.safeParse("Home_Kitchen").success).toBe(false);
  });

  it("labels parents and leaves", () => {
    expect(categoryLabel("arts_crafts.pottery_ceramics")).toBe("Pottery & ceramics");
    expect(categoryLabel("office")).toBe("Office");
    expect(() => categoryLabel("bogus" as CategorySelector)).toThrow(TypeError);
  });
});

describe("categoryAllowed", () => {
  const hero: CategorySelector[] = ["arts_crafts.pottery_ceramics", "home_kitchen.drinkware", "home_decor"];

  it.each([
    ["an exact leaf", "home_kitchen.drinkware", true],
    ["a leaf under an allowed parent", "home_decor.wall_decor", true],
    ["a sibling of an allowed leaf", "home_kitchen.cookware", false],
    ["a protection plan", "services.protection_plans", false],
    ["a parent code posing as a leaf", "home_decor", false],
    ["an unknown code", "home_decor.anything", false],
    ["free text", "pottery", false],
  ])("%s", (_name, leaf, expected) => {
    expect(categoryAllowed(hero, leaf)).toBe(expected);
  });

  it("allows nothing with no selectors", () => {
    expect(categoryAllowed([], "office.paper")).toBe(false);
  });
});

describe("item kinds", () => {
  it("can deny every kind except plain goods", () => {
    expect([...DENIABLE_KINDS].sort()).toEqual(ITEM_KINDS.filter((kind) => kind !== "goods").sort());
    expect(DeniableKindSchema.safeParse("goods").success).toBe(false);
    expect(ItemKindSchema.safeParse("goods").success).toBe(true);
    for (const kind of ITEM_KINDS) expect(ITEM_KIND_LABELS[kind].length).toBeGreaterThan(0);
  });

  it("checks deny lists and fails closed on unknown kinds", () => {
    expect(kindDenied(["gift_card", "protection_plan"], "protection_plan")).toBe(true);
    expect(kindDenied(["gift_card"], "subscription")).toBe(false);
    expect(kindDenied([...DENIABLE_KINDS], "goods")).toBe(false);
    expect(kindDenied([], "warranty")).toBe(true);
  });
});
