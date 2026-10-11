-- ─────────────────────────────────────────────────────────────────────────
-- Phase 14 — purchasing: suppliers, purchase orders, goods receipts,
-- supplier invoices, supplier payments, and purchasing reconciliation.
--
-- Rules this migration enforces:
--   * Stock enters the ledger only through goods_receipt_post, which books one
--     inventory receipt movement per receipt line (reference 'grn:<line id>').
--   * A purchase order cannot be received beyond what was ordered.
--   * An invoice bills receipt lines once, from one supplier and one outlet.
--   * Posted receipts, invoices and payments cannot be updated or deleted.
--   * Supplier payments cannot exceed the amount owed.
--   * Writes go through RPCs (service role). Authenticated users only read,
--     under purchasing.view (supplier, order, receipt and invoice records) and
--     the outlet grant (order, receipt and invoice rows).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. helpers ──────────────────────────────────────────────────────────────

-- Today's date in the business timezone (IST). Used for receipt and payment dates.
create or replace function public.business_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- Per-business running numbers (purchase orders, goods receipts). The upsert
-- row-locks the counter, so numbers are unique and gap-free under concurrency.
create table public.business_sequences (
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind text not null constraint business_sequences_kind_allowed check (kind in ('purchase_order', 'goods_receipt')),
  last_value integer not null default 0,
  primary key (business_id, kind)
);
alter table public.business_sequences enable row level security;

create or replace function public.next_business_number(p_business uuid, p_kind text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
begin
  insert into public.business_sequences (business_id, kind, last_value)
  values (p_business, p_kind, 1)
  on conflict (business_id, kind)
  do update set last_value = public.business_sequences.last_value + 1
  returning last_value into v_value;
  return v_value;
end;
$$;

revoke all on function public.next_business_number(uuid, text) from public, anon, authenticated, service_role;

-- ── 2. suppliers ────────────────────────────────────────────────────────────

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint suppliers_name_length check (char_length(trim(name)) between 1 and 120),
  contact_name text
    constraint suppliers_contact_length check (contact_name is null or char_length(contact_name) <= 80),
  phone text
    constraint suppliers_phone_format check (phone is null or phone ~ '^[+0-9 ()-]{6,20}$'),
  email text
    constraint suppliers_email_format check (
      email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    ),
  gstin text
    constraint suppliers_gstin_format check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  address text
    constraint suppliers_address_length check (address is null or char_length(address) <= 300),
  payment_terms_days integer not null default 0
    constraint suppliers_terms_range check (payment_terms_days between 0 and 365),
  status text not null default 'active'
    constraint suppliers_status_allowed check (status in ('active', 'inactive')),
  notes text
    constraint suppliers_notes_length check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index suppliers_name_unique on public.suppliers (business_id, lower(trim(name)));

-- ── 3. purchase orders ──────────────────────────────────────────────────────

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  number integer not null constraint purchase_orders_number_positive check (number > 0),
  status text not null default 'draft'
    constraint purchase_orders_status_allowed check (
      status in ('draft', 'sent', 'partially_received', 'received', 'cancelled')
    ),
  expected_on date,
  notes text constraint purchase_orders_notes_length check (notes is null or char_length(notes) <= 500),
  subtotal_minor numeric(16, 4) not null default 0 constraint purchase_orders_subtotal_range check (subtotal_minor >= 0),
  created_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz,
  sent_by uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null,
  cancel_reason text constraint purchase_orders_cancel_reason_length check (cancel_reason is null or char_length(cancel_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, number)
);
create index purchase_orders_outlet_status_idx on public.purchase_orders (outlet_id, status);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  unit text not null references public.units (code),
  qty_ordered numeric(14, 3) not null constraint purchase_order_items_qty_positive check (qty_ordered > 0),
  unit_cost numeric(14, 4) not null constraint purchase_order_items_cost_range check (unit_cost >= 0),
  qty_ordered_base numeric(14, 3) not null constraint purchase_order_items_base_positive check (qty_ordered_base > 0),
  qty_received_base numeric(14, 3) not null default 0 constraint purchase_order_items_received_range check (qty_received_base >= 0),
  line_total_minor numeric(16, 4) generated always as (round(qty_ordered * unit_cost, 4)) stored,
  created_at timestamptz not null default now(),
  constraint purchase_order_items_not_over_received check (qty_received_base <= qty_ordered_base),
  unique (purchase_order_id, ingredient_id)
);

-- ── 4. goods receipts ───────────────────────────────────────────────────────

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  purchase_order_id uuid not null references public.purchase_orders (id) on delete restrict,
  number integer not null constraint goods_receipts_number_positive check (number > 0),
  received_on date not null default public.business_today(),
  delivery_note text constraint goods_receipts_delivery_note_length check (delivery_note is null or char_length(delivery_note) <= 80),
  notes text constraint goods_receipts_notes_length check (notes is null or char_length(notes) <= 500),
  client_ref text not null
    constraint goods_receipts_client_ref_length check (char_length(client_ref) between 8 and 120),
  received_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, number),
  unique (business_id, client_ref)
);
create index goods_receipts_outlet_idx on public.goods_receipts (outlet_id, received_on);
create index goods_receipts_supplier_idx on public.goods_receipts (supplier_id, received_on);

create table public.goods_receipt_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  goods_receipt_id uuid not null references public.goods_receipts (id) on delete restrict,
  purchase_order_item_id uuid not null references public.purchase_order_items (id) on delete restrict,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  unit text not null references public.units (code),
  qty numeric(14, 3) not null constraint goods_receipt_items_qty_positive check (qty > 0),
  qty_base numeric(14, 3) not null constraint goods_receipt_items_base_positive check (qty_base > 0),
  unit_cost numeric(14, 4) not null constraint goods_receipt_items_cost_range check (unit_cost >= 0),
  line_total_minor numeric(16, 4) generated always as (round(qty * unit_cost, 4)) stored,
  batch_code text constraint goods_receipt_items_batch_length check (batch_code is null or char_length(batch_code) <= 40),
  expires_on date,
  created_at timestamptz not null default now(),
  unique (goods_receipt_id, purchase_order_item_id)
);
create index goods_receipt_items_ingredient_idx on public.goods_receipt_items (ingredient_id);

-- ── 5. supplier invoices ────────────────────────────────────────────────────

create table public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  invoice_number text not null
    constraint purchase_invoices_number_length check (char_length(trim(invoice_number)) between 1 and 40),
  invoice_date date not null,
  due_on date not null,
  subtotal_minor numeric(16, 4) not null default 0 constraint purchase_invoices_subtotal_range check (subtotal_minor >= 0),
  tax_minor numeric(16, 4) not null default 0 constraint purchase_invoices_tax_range check (tax_minor >= 0),
  total_minor numeric(16, 4) not null default 0 constraint purchase_invoices_total_range check (total_minor >= 0),
  notes text constraint purchase_invoices_notes_length check (notes is null or char_length(notes) <= 500),
  client_ref text not null
    constraint purchase_invoices_client_ref_length check (char_length(client_ref) between 8 and 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint purchase_invoices_due_after_invoice check (due_on >= invoice_date),
  constraint purchase_invoices_total_is_sum check (total_minor = subtotal_minor + tax_minor),
  unique (business_id, client_ref)
);
create unique index purchase_invoices_number_unique
  on public.purchase_invoices (business_id, supplier_id, lower(trim(invoice_number)));
create index purchase_invoices_outlet_idx on public.purchase_invoices (outlet_id, invoice_date);

create table public.purchase_invoice_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  invoice_id uuid not null references public.purchase_invoices (id) on delete restrict,
  goods_receipt_item_id uuid not null references public.goods_receipt_items (id) on delete restrict,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  unit text not null references public.units (code),
  qty numeric(14, 3) not null constraint purchase_invoice_items_qty_positive check (qty > 0),
  unit_cost numeric(14, 4) not null constraint purchase_invoice_items_cost_range check (unit_cost >= 0),
  line_total_minor numeric(16, 4) generated always as (round(qty * unit_cost, 4)) stored,
  created_at timestamptz not null default now(),
  -- one bill per receipt line
  constraint purchase_invoice_items_receipt_once unique (goods_receipt_item_id)
);
create index purchase_invoice_items_invoice_idx on public.purchase_invoice_items (invoice_id);

-- ── 6. supplier payments ────────────────────────────────────────────────────

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  amount_minor numeric(16, 4) not null constraint supplier_payments_amount_positive check (amount_minor > 0),
  method text not null
    constraint supplier_payments_method_allowed check (method in ('cash', 'bank_transfer', 'upi', 'cheque', 'card', 'other')),
  paid_on date not null default public.business_today(),
  reference text constraint supplier_payments_reference_length check (reference is null or char_length(reference) <= 80),
  notes text constraint supplier_payments_notes_length check (notes is null or char_length(notes) <= 300),
  client_ref text not null
    constraint supplier_payments_client_ref_length check (char_length(client_ref) between 8 and 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, client_ref)
);
create index supplier_payments_supplier_idx on public.supplier_payments (supplier_id, paid_on);

-- ── 7. posted records are immutable ─────────────────────────────────────────

create or replace function public.purchasing_posted_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Posted purchasing records cannot be changed or deleted.' using errcode = 'P0001';
end;
$$;

create trigger goods_receipts_immutable
  before update or delete on public.goods_receipts
  for each row execute function public.purchasing_posted_immutable();
create trigger goods_receipt_items_immutable
  before update or delete on public.goods_receipt_items
  for each row execute function public.purchasing_posted_immutable();
create trigger purchase_invoices_immutable
  before update or delete on public.purchase_invoices
  for each row execute function public.purchasing_posted_immutable();
create trigger purchase_invoice_items_immutable
  before update or delete on public.purchase_invoice_items
  for each row execute function public.purchasing_posted_immutable();
create trigger supplier_payments_immutable
  before update or delete on public.supplier_payments
  for each row execute function public.purchasing_posted_immutable();

-- ── 8. row-level security (read only; writes via RPCs) ──────────────────────

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.goods_receipts enable row level security;
alter table public.goods_receipt_items enable row level security;
alter table public.purchase_invoices enable row level security;
alter table public.purchase_invoice_items enable row level security;
alter table public.supplier_payments enable row level security;

create policy suppliers_read on public.suppliers for select
  using (public.has_business_permission(business_id, 'purchasing.view'));

create policy purchase_orders_read on public.purchase_orders for select
  using (public.has_outlet_permission(outlet_id, 'purchasing.view'));

create policy purchase_order_items_read on public.purchase_order_items for select
  using (exists (
    select 1 from public.purchase_orders po
    where po.id = purchase_order_id and public.has_outlet_permission(po.outlet_id, 'purchasing.view')
  ));

create policy goods_receipts_read on public.goods_receipts for select
  using (public.has_outlet_permission(outlet_id, 'purchasing.view'));

create policy goods_receipt_items_read on public.goods_receipt_items for select
  using (exists (
    select 1 from public.goods_receipts gr
    where gr.id = goods_receipt_id and public.has_outlet_permission(gr.outlet_id, 'purchasing.view')
  ));

create policy purchase_invoices_read on public.purchase_invoices for select
  using (public.has_outlet_permission(outlet_id, 'purchasing.view'));

create policy purchase_invoice_items_read on public.purchase_invoice_items for select
  using (exists (
    select 1 from public.purchase_invoices pi
    where pi.id = invoice_id and public.has_outlet_permission(pi.outlet_id, 'purchasing.view')
  ));

create policy supplier_payments_read on public.supplier_payments for select
  using (public.has_business_permission(business_id, 'purchasing.view'));

grant select on public.suppliers, public.purchase_orders, public.purchase_order_items,
  public.goods_receipts, public.goods_receipt_items, public.purchase_invoices,
  public.purchase_invoice_items, public.supplier_payments to authenticated;

-- ── 9. internal: book one receipt into the inventory ledger ─────────────────
-- Called only from goods_receipt_post. The caller has already checked the
-- purchasing permission and the outlet grant. Same rules as inventory_receive:
-- a batch with cost and expiry, plus one receipt movement.

create or replace function public.inventory_book_receipt(
  p_business uuid,
  p_outlet uuid,
  p_ingredient uuid,
  p_qty_base numeric,
  p_unit text,
  p_unit_cost numeric,
  p_batch_code text,
  p_expires_on date,
  p_reference_key text,
  p_actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to_base numeric;
  v_cost_base numeric;
  v_batch uuid;
begin
  select u.to_base into v_to_base from public.units u where u.code = p_unit;
  if v_to_base is null then raise exception 'Unknown unit.' using errcode = 'P0001'; end if;
  v_cost_base := p_unit_cost / v_to_base;

  insert into public.inventory_batches (
    business_id, outlet_id, ingredient_id, batch_code, received_qty, remaining_qty,
    unit_cost, received_on, expires_on, source
  ) values (
    p_business, p_outlet, p_ingredient, nullif(trim(coalesce(p_batch_code, '')), ''), p_qty_base, 0,
    v_cost_base, public.business_today(), p_expires_on, 'receipt'
  ) returning id into v_batch;

  insert into public.inventory_movements (
    business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor, reference_key, actor_id
  ) values (
    p_business, p_outlet, p_ingredient, v_batch, 'receipt', p_qty_base, v_cost_base,
    p_qty_base * v_cost_base, p_reference_key, p_actor
  );

  return v_batch;
end;
$$;

revoke all on function public.inventory_book_receipt(uuid, uuid, uuid, numeric, text, numeric, text, date, text, uuid)
  from public, anon, authenticated, service_role;

-- ── 10. RPC: supplier_save ──────────────────────────────────────────────────

create or replace function public.supplier_save(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid,
  p_name text,
  p_contact_name text,
  p_phone text,
  p_email text,
  p_gstin text,
  p_address text,
  p_payment_terms_days integer,
  p_status text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'purchasing.manage') then
    raise exception 'Your role does not allow this action (purchasing.manage).' using errcode = '42501';
  end if;

  if p_id is not null then
    perform 1 from public.suppliers s where s.id = p_id and s.business_id = p_business_id for update;
    if not found then raise exception 'Supplier not found.' using errcode = 'P0001'; end if;
  end if;

  begin
    if p_id is null then
      insert into public.suppliers (
        business_id, name, contact_name, phone, email, gstin, address, payment_terms_days, status, notes
      ) values (
        p_business_id, trim(p_name), nullif(trim(coalesce(p_contact_name, '')), ''),
        nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''),
        nullif(upper(trim(coalesce(p_gstin, ''))), ''), nullif(trim(coalesce(p_address, '')), ''),
        coalesce(p_payment_terms_days, 0), coalesce(p_status, 'active'),
        nullif(trim(coalesce(p_notes, '')), '')
      ) returning id into v_id;
    else
      update public.suppliers s set
        name = trim(p_name),
        contact_name = nullif(trim(coalesce(p_contact_name, '')), ''),
        phone = nullif(trim(coalesce(p_phone, '')), ''),
        email = nullif(trim(coalesce(p_email, '')), ''),
        gstin = nullif(upper(trim(coalesce(p_gstin, ''))), ''),
        address = nullif(trim(coalesce(p_address, '')), ''),
        payment_terms_days = coalesce(p_payment_terms_days, 0),
        status = coalesce(p_status, 'active'),
        notes = nullif(trim(coalesce(p_notes, '')), ''),
        updated_at = now()
      where s.id = p_id
      returning s.id into v_id;
    end if;
  exception when unique_violation then
    raise exception 'A supplier with this name already exists.' using errcode = 'P0001';
  end;

  return v_id;
end;
$$;

revoke all on function public.supplier_save(uuid, uuid, uuid, text, text, text, text, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.supplier_save(uuid, uuid, uuid, text, text, text, text, text, text, integer, text, text)
  to service_role;

-- ── 11. RPC: purchase_order_save (draft create / edit) ──────────────────────

create or replace function public.purchase_order_save(
  p_actor uuid,
  p_outlet_id uuid,
  p_supplier_id uuid,
  p_id uuid,
  p_expected_on date,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_po record;
  v_id uuid;
  v_number integer;
  v_line jsonb;
  v_ing record;
  v_qty numeric;
  v_cost numeric;
  v_qty_base numeric;
begin
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'purchasing.manage');

  if not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.business_id = v_business and s.status = 'active'
  ) then
    raise exception 'Choose an active supplier.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line to the order.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 60 then
    raise exception 'At most 60 lines per order.' using errcode = 'P0001';
  end if;

  if p_id is null then
    v_number := public.next_business_number(v_business, 'purchase_order');
    insert into public.purchase_orders (business_id, outlet_id, supplier_id, number, status, expected_on, notes, created_by)
    values (v_business, p_outlet_id, p_supplier_id, v_number, 'draft', p_expected_on,
            nullif(trim(coalesce(p_notes, '')), ''), p_actor)
    returning id into v_id;
  else
    select * into v_po from public.purchase_orders po where po.id = p_id for update;
    if not found or v_po.business_id <> v_business or v_po.outlet_id <> p_outlet_id then
      raise exception 'Order not found.' using errcode = 'P0001';
    end if;
    if v_po.status <> 'draft' then
      raise exception 'Only draft orders can be edited.' using errcode = 'P0001';
    end if;
    update public.purchase_orders po set
      supplier_id = p_supplier_id, expected_on = p_expected_on,
      notes = nullif(trim(coalesce(p_notes, '')), ''), updated_at = now()
    where po.id = p_id;
    delete from public.purchase_order_items where purchase_order_id = p_id;
    v_id := p_id;
  end if;

  begin
    for v_line in select * from jsonb_array_elements(p_lines) loop
      select i.* into v_ing from public.ingredients i
      where i.id = nullif(v_line ->> 'ingredient_id', '')::uuid and i.business_id = v_business and i.active;
      if not found then
        raise exception 'Choose an active ingredient for every line.' using errcode = 'P0001';
      end if;
      v_qty := (v_line ->> 'qty')::numeric;
      v_cost := (v_line ->> 'unit_cost')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'Quantity must be more than zero.' using errcode = 'P0001';
      end if;
      if v_cost is null or v_cost < 0 then
        raise exception 'Cost cannot be negative.' using errcode = 'P0001';
      end if;
      -- refuses unit families that do not match the ingredient
      v_qty_base := public.inventory_base_qty(v_ing.unit, v_line ->> 'unit', v_qty);

      insert into public.purchase_order_items (
        business_id, purchase_order_id, ingredient_id, unit, qty_ordered, unit_cost, qty_ordered_base
      ) values (
        v_business, v_id, v_ing.id, v_line ->> 'unit', v_qty, v_cost, v_qty_base
      );
    end loop;
  exception when unique_violation then
    raise exception 'Each ingredient can appear once per order.' using errcode = 'P0001';
  end;

  update public.purchase_orders po set
    subtotal_minor = (select coalesce(sum(poi.line_total_minor), 0) from public.purchase_order_items poi where poi.purchase_order_id = v_id),
    updated_at = now()
  where po.id = v_id;

  return v_id;
end;
$$;

revoke all on function public.purchase_order_save(uuid, uuid, uuid, uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.purchase_order_save(uuid, uuid, uuid, uuid, date, text, jsonb) to service_role;

-- ── 12. RPC: send and cancel ────────────────────────────────────────────────

create or replace function public.purchase_order_send(p_actor uuid, p_po uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po record;
  v_business uuid;
begin
  select * into v_po from public.purchase_orders po where po.id = p_po for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0001'; end if;
  v_business := public.require_outlet_permission(p_actor, v_po.outlet_id, 'purchasing.manage');

  if v_po.status <> 'draft' then
    raise exception 'Only draft orders can be sent.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.purchase_order_items poi where poi.purchase_order_id = p_po) then
    raise exception 'Add at least one line before sending.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.suppliers s where s.id = v_po.supplier_id and s.status = 'active') then
    raise exception 'This supplier is inactive. Reactivate them before sending.' using errcode = 'P0001';
  end if;

  update public.purchase_orders po set status = 'sent', sent_at = now(), sent_by = p_actor, updated_at = now()
  where po.id = p_po;

  perform public.write_audit_log(v_business, v_po.outlet_id, p_actor, 'purchase_order.sent',
    'purchase_order', p_po::text, null, jsonb_build_object('status', 'sent'));
  return p_po;
end;
$$;

revoke all on function public.purchase_order_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purchase_order_send(uuid, uuid) to service_role;

create or replace function public.purchase_order_cancel(p_actor uuid, p_po uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po record;
  v_business uuid;
begin
  select * into v_po from public.purchase_orders po where po.id = p_po for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0001'; end if;
  v_business := public.require_outlet_permission(p_actor, v_po.outlet_id, 'purchasing.manage');

  if v_po.status not in ('draft', 'sent') then
    raise exception 'Only draft or sent orders can be cancelled.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.purchase_order_items poi where poi.purchase_order_id = p_po and poi.qty_received_base > 0) then
    raise exception 'Stock has already been received against this order, so it cannot be cancelled.' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for cancelling (at least 3 characters).' using errcode = 'P0001';
  end if;

  update public.purchase_orders po set
    status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor,
    cancel_reason = left(trim(p_reason), 200), updated_at = now()
  where po.id = p_po;

  perform public.write_audit_log(v_business, v_po.outlet_id, p_actor, 'purchase_order.cancelled',
    'purchase_order', p_po::text, null, jsonb_build_object('status', 'cancelled'));
  return p_po;
end;
$$;

revoke all on function public.purchase_order_cancel(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.purchase_order_cancel(uuid, uuid, text) to service_role;

-- ── 13. RPC: goods_receipt_post ─────────────────────────────────────────────
-- Lines: [{ po_item_id, qty, unit?, unit_cost?, batch_code?, expires_on? }].
-- Quantities are in the line's unit, converted to base units here. Costs
-- default to the order's cost. Idempotent on client_ref.

create or replace function public.goods_receipt_post(
  p_actor uuid,
  p_po uuid,
  p_client_ref text,
  p_delivery_note text,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po record;
  v_business uuid;
  v_existing record;
  v_grn uuid;
  v_number integer;
  v_line jsonb;
  v_poi record;
  v_qty numeric;
  v_unit text;
  v_qty_base numeric;
  v_cost numeric;
  v_expires date;
  v_batch_code text;
  v_item uuid;
begin
  if char_length(coalesce(p_client_ref, '')) < 8 then
    raise exception 'Missing reference for this receipt.' using errcode = 'P0001';
  end if;

  select * into v_po from public.purchase_orders po where po.id = p_po for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0001'; end if;
  v_business := public.require_outlet_permission(p_actor, v_po.outlet_id, 'purchasing.manage');

  -- idempotent retry: the same reference returns the receipt it created
  select gr.* into v_existing from public.goods_receipts gr
  where gr.business_id = v_business and gr.client_ref = p_client_ref;
  if found then
    if v_existing.purchase_order_id <> p_po then
      raise exception 'This reference was already used for another receipt.' using errcode = 'P0001';
    end if;
    return v_existing.id;
  end if;

  if v_po.status not in ('sent', 'partially_received') then
    raise exception 'This order is not open for receiving.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Enter the quantity received for at least one line.' using errcode = 'P0001';
  end if;

  v_number := public.next_business_number(v_business, 'goods_receipt');
  insert into public.goods_receipts (
    business_id, outlet_id, supplier_id, purchase_order_id, number, delivery_note, notes, client_ref, received_by
  ) values (
    v_business, v_po.outlet_id, v_po.supplier_id, p_po, v_number,
    nullif(trim(coalesce(p_delivery_note, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    p_client_ref, p_actor
  ) returning id into v_grn;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select poi.*, i.unit as ingredient_unit, i.name as ingredient_name into v_poi
    from public.purchase_order_items poi
    join public.ingredients i on i.id = poi.ingredient_id
    where poi.id = nullif(v_line ->> 'po_item_id', '')::uuid and poi.purchase_order_id = p_po;
    if not found then
      raise exception 'A line does not belong to this order.' using errcode = 'P0001';
    end if;

    v_unit := coalesce(nullif(v_line ->> 'unit', ''), v_poi.unit);
    v_qty := (v_line ->> 'qty')::numeric;
    v_qty_base := public.inventory_base_qty(v_poi.ingredient_unit, v_unit, v_qty);
    v_cost := case when nullif(v_line ->> 'unit_cost', '') is null then v_poi.unit_cost
                   else (v_line ->> 'unit_cost')::numeric end;
    if v_cost < 0 then raise exception 'Cost cannot be negative.' using errcode = 'P0001'; end if;

    if v_poi.qty_received_base + v_qty_base > v_poi.qty_ordered_base then
      raise exception 'More than ordered was entered for %. Receive no more than is outstanding.', v_poi.ingredient_name
        using errcode = 'P0001';
    end if;

    v_expires := nullif(v_line ->> 'expires_on', '')::date;
    if v_expires is not null and v_expires < public.business_today() then
      raise exception 'The batch for % has already expired.', v_poi.ingredient_name using errcode = 'P0001';
    end if;
    v_batch_code := nullif(trim(coalesce(v_line ->> 'batch_code', '')), '');

    insert into public.goods_receipt_items (
      business_id, goods_receipt_id, purchase_order_item_id, ingredient_id, unit,
      qty, qty_base, unit_cost, batch_code, expires_on
    ) values (
      v_business, v_grn, v_poi.id, v_poi.ingredient_id, v_unit,
      v_qty, v_qty_base, v_cost, v_batch_code, v_expires
    ) returning id into v_item;

    -- the ledger: one batch and one receipt movement per line
    perform public.inventory_book_receipt(
      v_business, v_po.outlet_id, v_poi.ingredient_id, v_qty_base, v_unit, v_cost,
      v_batch_code, v_expires, 'grn:' || v_item::text, p_actor
    );

    update public.purchase_order_items poi
    set qty_received_base = poi.qty_received_base + v_qty_base
    where poi.id = v_poi.id;
  end loop;

  update public.purchase_orders po set
    status = case when exists (
      select 1 from public.purchase_order_items poi
      where poi.purchase_order_id = p_po and poi.qty_received_base < poi.qty_ordered_base
    ) then 'partially_received' else 'received' end,
    updated_at = now()
  where po.id = p_po;

  perform public.write_audit_log(v_business, v_po.outlet_id, p_actor, 'goods_receipt.posted',
    'goods_receipt', v_grn::text, null, jsonb_build_object('purchase_order', p_po));
  return v_grn;
end;
$$;

revoke all on function public.goods_receipt_post(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.goods_receipt_post(uuid, uuid, text, text, text, jsonb) to service_role;

-- ── 14. RPC: purchase_invoice_post ──────────────────────────────────────────
-- Lines: [{ goods_receipt_item_id, unit_cost }]. The billed quantity is the
-- received quantity. Totals are computed here, never taken from the client.

create or replace function public.purchase_invoice_post(
  p_actor uuid,
  p_outlet_id uuid,
  p_supplier_id uuid,
  p_invoice_number text,
  p_invoice_date date,
  p_due_on date,
  p_tax_minor numeric,
  p_notes text,
  p_client_ref text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_existing record;
  v_line jsonb;
  v_gri record;
  v_cost numeric;
  v_subtotal numeric := 0;
  v_invoice uuid;
begin
  if char_length(coalesce(p_client_ref, '')) < 8 then
    raise exception 'Missing reference for this invoice.' using errcode = 'P0001';
  end if;
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'purchasing.manage');

  select pi.* into v_existing from public.purchase_invoices pi
  where pi.business_id = v_business and pi.client_ref = p_client_ref;
  if found then
    if v_existing.supplier_id <> p_supplier_id or v_existing.outlet_id <> p_outlet_id then
      raise exception 'This reference was already used for another invoice.' using errcode = 'P0001';
    end if;
    return v_existing.id;
  end if;

  if char_length(trim(coalesce(p_invoice_number, ''))) = 0 then
    raise exception 'Enter the supplier''s invoice number.' using errcode = 'P0001';
  end if;
  if p_due_on < p_invoice_date then
    raise exception 'The due date cannot be before the invoice date.' using errcode = 'P0001';
  end if;
  if coalesce(p_tax_minor, 0) < 0 then
    raise exception 'Tax cannot be negative.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.suppliers s where s.id = p_supplier_id and s.business_id = v_business) then
    raise exception 'Supplier not found.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Choose at least one received line to bill.' using errcode = 'P0001';
  end if;

  -- pass 1: validate every line and compute the subtotal
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select gri.*, gr.supplier_id as receipt_supplier, gr.outlet_id as receipt_outlet, gr.business_id as receipt_business,
           i.name as ingredient_name
      into v_gri
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    join public.ingredients i on i.id = gri.ingredient_id
    where gri.id = nullif(v_line ->> 'goods_receipt_item_id', '')::uuid;
    if not found or v_gri.receipt_business <> v_business then
      raise exception 'A receipt line was not found.' using errcode = 'P0001';
    end if;
    if v_gri.receipt_supplier <> p_supplier_id then
      raise exception 'A receipt line belongs to a different supplier.' using errcode = 'P0001';
    end if;
    if v_gri.receipt_outlet <> p_outlet_id then
      raise exception 'A receipt line belongs to a different outlet.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.purchase_invoice_items pii where pii.goods_receipt_item_id = v_gri.id) then
      raise exception 'Already billed: %.', v_gri.ingredient_name using errcode = 'P0001';
    end if;
    v_cost := (v_line ->> 'unit_cost')::numeric;
    if v_cost is null or v_cost < 0 then
      raise exception 'Cost cannot be negative.' using errcode = 'P0001';
    end if;
    v_subtotal := v_subtotal + round(v_gri.qty * v_cost, 4);
  end loop;

  begin
    insert into public.purchase_invoices (
      business_id, outlet_id, supplier_id, invoice_number, invoice_date, due_on,
      subtotal_minor, tax_minor, total_minor, notes, client_ref, created_by
    ) values (
      v_business, p_outlet_id, p_supplier_id, trim(p_invoice_number), p_invoice_date, p_due_on,
      v_subtotal, coalesce(p_tax_minor, 0), v_subtotal + coalesce(p_tax_minor, 0),
      nullif(trim(coalesce(p_notes, '')), ''), p_client_ref, p_actor
    ) returning id into v_invoice;
  exception when unique_violation then
    raise exception 'That invoice number is already recorded for this supplier.' using errcode = 'P0001';
  end;

  -- pass 2: write the billed lines (the unique index stops a receipt line being billed twice)
  begin
    for v_line in select * from jsonb_array_elements(p_lines) loop
      insert into public.purchase_invoice_items (
        business_id, invoice_id, goods_receipt_item_id, ingredient_id, unit, qty, unit_cost
      )
      select v_business, v_invoice, gri.id, gri.ingredient_id, gri.unit, gri.qty,
             (v_line ->> 'unit_cost')::numeric
      from public.goods_receipt_items gri
      where gri.id = (v_line ->> 'goods_receipt_item_id')::uuid;
    end loop;
  exception when unique_violation then
    raise exception 'Each received line can be billed once.' using errcode = 'P0001';
  end;

  perform public.write_audit_log(v_business, p_outlet_id, p_actor, 'purchase_invoice.posted',
    'purchase_invoice', v_invoice::text, null, jsonb_build_object('supplier', p_supplier_id, 'total_minor', v_subtotal + coalesce(p_tax_minor, 0)));
  return v_invoice;
end;
$$;

revoke all on function public.purchase_invoice_post(uuid, uuid, uuid, text, date, date, numeric, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.purchase_invoice_post(uuid, uuid, uuid, text, date, date, numeric, text, text, jsonb)
  to service_role;

-- ── 15. RPC: supplier_payment_record ────────────────────────────────────────

create or replace function public.supplier_payment_record(
  p_actor uuid,
  p_business_id uuid,
  p_supplier_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_on date,
  p_reference text,
  p_notes text,
  p_client_ref text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
  v_owed numeric;
  v_id uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'purchasing.manage') then
    raise exception 'Your role does not allow this action (purchasing.manage).' using errcode = '42501';
  end if;
  if char_length(coalesce(p_client_ref, '')) < 8 then
    raise exception 'Missing reference for this payment.' using errcode = 'P0001';
  end if;

  select sp.* into v_existing from public.supplier_payments sp
  where sp.business_id = p_business_id and sp.client_ref = p_client_ref;
  if found then
    if v_existing.supplier_id <> p_supplier_id then
      raise exception 'This reference was already used for another payment.' using errcode = 'P0001';
    end if;
    return v_existing.id;
  end if;

  perform 1 from public.suppliers s where s.id = p_supplier_id and s.business_id = p_business_id for update;
  if not found then raise exception 'Supplier not found.' using errcode = 'P0001'; end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment must be more than zero.' using errcode = 'P0001';
  end if;

  v_owed := (select coalesce(sum(pi.total_minor), 0) from public.purchase_invoices pi where pi.supplier_id = p_supplier_id)
          - (select coalesce(sum(sp.amount_minor), 0) from public.supplier_payments sp where sp.supplier_id = p_supplier_id);
  if p_amount > v_owed then
    raise exception 'That payment is more than the amount owed to this supplier.' using errcode = 'P0001';
  end if;

  insert into public.supplier_payments (
    business_id, supplier_id, amount_minor, method, paid_on, reference, notes, client_ref, created_by
  ) values (
    p_business_id, p_supplier_id, p_amount, p_method, coalesce(p_paid_on, public.business_today()),
    nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), p_client_ref, p_actor
  ) returning id into v_id;

  perform public.write_audit_log(p_business_id, null, p_actor, 'supplier.payment_recorded',
    'supplier', p_supplier_id::text, null, jsonb_build_object('amount_minor', p_amount, 'method', p_method));
  return v_id;
end;
$$;

revoke all on function public.supplier_payment_record(uuid, uuid, uuid, numeric, text, date, text, text, text)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_record(uuid, uuid, uuid, numeric, text, date, text, text, text)
  to service_role;

-- ── 16. reconciliation ──────────────────────────────────────────────────────
-- Each check compares two independent records. A check passes when the two
-- agree within a rounding tolerance (one hundredth of a unit per line).

create or replace function public.purchasing_reconcile(p_actor uuid, p_outlet_id uuid)
returns table (check_name text, expected numeric, actual numeric, ok boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_outlet_permission(p_actor, p_outlet_id, 'purchasing.view');

  return query
  with grn as (
    select gri.id, gri.qty_base, gri.line_total_minor
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.outlet_id = p_outlet_id
  ),
  mov as (
    select m.reference_key, m.qty, m.value_minor
    from public.inventory_movements m
    where m.outlet_id = p_outlet_id and m.kind = 'receipt' and m.reference_key like 'grn:%'
  ),
  checks as (
    select 'Every receipt line has one ledger receipt'::text as name,
      (select count(*) from grn)::numeric as expected,
      (select count(*) from grn g where exists (select 1 from mov m where m.reference_key = 'grn:' || g.id::text))::numeric as actual,
      0::numeric as tolerance
    union all
    select 'Receipt value in the ledger equals the receipt lines',
      (select coalesce(sum(g.line_total_minor), 0) from grn g),
      (select coalesce(sum(m.value_minor), 0) from mov m join grn g on m.reference_key = 'grn:' || g.id::text),
      0.01 * greatest((select count(*) from grn), 1)
    union all
    select 'Receipt quantity in the ledger equals received quantity',
      (select coalesce(sum(g.qty_base), 0) from grn g),
      (select coalesce(sum(m.qty), 0) from mov m join grn g on m.reference_key = 'grn:' || g.id::text),
      0.001 * greatest((select count(*) from grn), 1)
    union all
    select 'Order received quantity equals the receipt lines',
      (select coalesce(sum(poi.qty_received_base), 0) from public.purchase_order_items poi
         join public.purchase_orders po on po.id = poi.purchase_order_id where po.outlet_id = p_outlet_id),
      (select coalesce(sum(g.qty_base), 0) from grn g),
      0.001 * greatest((select count(*) from grn), 1)
    union all
    select 'Invoice subtotal equals the billed lines',
      (select coalesce(sum(pi.subtotal_minor), 0) from public.purchase_invoices pi where pi.outlet_id = p_outlet_id),
      (select coalesce(sum(pii.line_total_minor), 0) from public.purchase_invoice_items pii
         join public.purchase_invoices pi on pi.id = pii.invoice_id where pi.outlet_id = p_outlet_id),
      0.01 * greatest((select count(*) from public.purchase_invoices pi where pi.outlet_id = p_outlet_id), 1)
    union all
    select 'Invoice total equals subtotal plus tax',
      (select coalesce(sum(pi.total_minor), 0) from public.purchase_invoices pi where pi.outlet_id = p_outlet_id),
      (select coalesce(sum(pi.subtotal_minor + pi.tax_minor), 0) from public.purchase_invoices pi where pi.outlet_id = p_outlet_id),
      0.01 * greatest((select count(*) from public.purchase_invoices pi where pi.outlet_id = p_outlet_id), 1)
  )
  select c.name, c.expected, c.actual, abs(c.expected - c.actual) <= c.tolerance
  from checks c;
end;
$$;

revoke all on function public.purchasing_reconcile(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purchasing_reconcile(uuid, uuid) to service_role;
