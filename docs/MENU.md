# RestroNex — Phase 7: Universal Menu Management

The menu is the **single source of truth** feeding POS, KDS, online ordering,
QR ordering, inventory and reports. Everything persists to PostgreSQL; there
is no fake CRUD anywhere.

## Data model (migration `20261008170000_universal_menu.sql`)

| Entity | Table | Notes |
|---|---|---|
| Categories + subcategories | `menu_categories` (+`parent_id`) | depth capped at 1 level (trigger) |
| Products | `menu_items` (+`sku`, `image_path`, `tax_rate_pct`) | SKU unique per business; tax override (`NULL` = inherit business tax settings) |
| Variants | `product_variants` | own price/SKU; name unique per product |
| Modifier groups | `modifier_groups` (`min_selected`/`max_selected`) | `min_selected = 0` ⇒ optional **add-on** |
| Modifiers (options) | `modifiers` | priced options inside a group |
| Product↔group links | `product_modifier_groups` | trigger blocks cross-business links |
| Combos | `combos` + `combo_items` | items reference products (+optional variant), qty 1–20 |
| Outlet pricing/availability | `outlet_product_overrides`, `outlet_variant_overrides` | missing row = base price & available |

Phase 6 onboarding data carries straight over — the starter menu tables were
extended, never duplicated.

### Price/availability resolution

`src/modules/menu/pricing.ts` → `resolveMenuValues(base, override)`:
- no override row → base price & availability
- override `price_minor = NULL` → base price, outlet availability applies
- a product whose **base** is unavailable never sells, whatever the override

## Management surfaces

- **Menu dashboard** `/menu` — live counts (products, categories, variants,
  modifier groups, combos, images) + category structure
- **Categories** `/menu/categories` — create root/subcategory, rename, delete
  (blocked while children/products exist)
- **Products** `/menu/products` — search (name/SKU), filter by
  category/availability/food type, **bulk** mark available/unavailable/delete
  (≤200 rows), product page with details + variants editor, modifier
  attach/detach, outlet overrides, image upload
- **Modifiers** `/menu/modifiers` — groups + options editor, "used by" list
- **Combos** `/menu/combos` — combo editor with product/variant picker rows

All pages resolve the business from the viewer's memberships (multi-business
picker when needed) and gate on `menu.view` / `menu.manage` — every action
re-authorises server-side; hidden `businessId` is a selector only.

## Images — Supabase Storage

- Bucket `menu-media` (public reads), object layout
  `{business_id}/{entity_id}/{uuid}.{ext}`
- **Storage policies (DB-enforced)**: public SELECT on `menu-media`;
  INSERT/UPDATE/DELETE only for **active members with a menu-management role**
  (owner/business_admin/outlet_manager) of the business named by the first
  path segment — cross-tenant writes are denied by the policy itself
- Server actions additionally validate type (JPEG/PNG/WebP) and size (≤5 MB),
  upload via the service role after RBAC checks, replace-and-clean old objects

## Verification layers

1. **Unit** (`npm test`): pricing resolver (override semantics), price
   conversion, product/variant/modifier/combo/override/filter schemas — 19
   menu tests.
2. **Local DB** (`npm run db:verify`, assertions-phase7.sql): RLS write
   denial on all 8 tables, category depth cap, SKU/variant uniqueness
   (per-business only), cross-business modifier-link guard, cascade deletes,
   storage policies (member writes in own folder, cross-tenant denied,
   non-menu roles denied), tenant read isolation.
3. **Hosted E2E** (`npm run test:menu:e2e` — needs pushed migrations +
   running app): full CRUD via real form POSTs, variant/override persistence,
   modifier attach, combos, bulk ops, and tenant-isolation attacks (forged
   writes, forged deletes, RLS reads with the attacker's JWT).
