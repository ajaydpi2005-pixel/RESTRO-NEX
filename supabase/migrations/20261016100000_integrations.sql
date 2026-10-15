-- ─────────────────────────────────────────────────────────────────────────
-- Phase 18 — External integrations framework.
--
-- Tables (names follow the master spec where it names them):
--   integration_accounts  one connection per (business, provider, outlet scope)
--   integration_secrets   encrypted credential blobs; ciphertext only, never plaintext
--   integration_jobs      outbound operations: leased, retried with backoff, idempotent
--   integration_logs      error log: one row per attempt, test, or state change
--   webhook_events        inbound receipts: verified, idempotent, no secrets stored
--
-- Rules enforced here, not only in the app:
--   • Swiggy and Zomato accept only mode 'demo' (no public API; partner onboarding first).
--   • A connection must pass a test (status 'connected') before any job can be queued.
--   • A job key is unique per account, so a retried request never sends twice.
--   • A webhook event id is accepted once; a reused id with a new payload is refused.
--   • Settings are never allowed to carry credential-looking keys.
--   • No client role (anon, authenticated) can read or write any of these tables.
--
-- Credentials are encrypted in the app (AES-256-GCM, key from the environment) and
-- bound to the account id, so a ciphertext cannot be moved between accounts.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Actor-based business permission (service-role RPCs need the actor) ──
create or replace function public.require_business_actor_permission(
  p_actor uuid,
  p_business_id uuid,
  p_permission text
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_actor is null then
    raise exception 'Sign-in required.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.memberships m
    join public.role_permissions rp
      on rp.role_key = m.role
     and rp.permission_key = p_permission
    where m.business_id = p_business_id
      and m.user_id = p_actor
      and m.status = 'active'
  ) then
    raise exception 'You do not have permission for this action.' using errcode = '42501';
  end if;
end $$;

revoke all on function public.require_business_actor_permission(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ── 2. Tables ──────────────────────────────────────────────────────────────

create table if not exists public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid references public.outlets (id) on delete cascade,
  provider text not null
    constraint integration_accounts_provider_allowed check (
      provider in ('razorpay', 'swiggy', 'zomato', 'whatsapp', 'sms', 'email', 'printer', 'accounting_export')
    ),
  mode text not null
    constraint integration_accounts_mode_allowed check (mode in ('demo', 'live')),
  enabled boolean not null default false,
  status text not null default 'not_configured'
    constraint integration_accounts_status_allowed check (status in ('not_configured', 'untested', 'connected', 'error')),
  config jsonb not null default '{}'::jsonb
    constraint integration_accounts_config_object check (jsonb_typeof(config) = 'object'),
  credential_hints jsonb not null default '{}'::jsonb
    constraint integration_accounts_hints_object check (jsonb_typeof(credential_hints) = 'object'),
  last_tested_at timestamptz,
  last_success_at timestamptz,
  last_error text
    constraint integration_accounts_last_error_length check (last_error is null or char_length(last_error) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_accounts_config_limit check (char_length(config::text) <= 4096),
  constraint integration_accounts_live_only_where_available check (
    provider not in ('swiggy', 'zomato') or mode = 'demo'
  )
);

create unique index if not exists integration_accounts_scope_unique
  on public.integration_accounts (business_id, provider, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.integration_accounts enable row level security;
revoke all on public.integration_accounts from public, anon, authenticated;

create table if not exists public.integration_secrets (
  account_id uuid primary key references public.integration_accounts (id) on delete cascade,
  ciphertext text not null
    constraint integration_secrets_ciphertext_format check (
      ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
      and char_length(ciphertext) <= 8192
    ),
  key_version integer not null default 1 constraint integration_secrets_key_version check (key_version >= 1),
  updated_at timestamptz not null default now()
);

alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from public, anon, authenticated;

-- ── On-site print agents. A tenant registers an agent per outlet; the agent holds a random
-- token and the database keeps only its SHA-256. Live printer jobs run through these agents.
create table if not exists public.integration_agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null
    constraint integration_agents_name_length check (char_length(trim(name)) between 1 and 60),
  token_hash text not null unique
    constraint integration_agents_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

alter table public.integration_agents enable row level security;
revoke all on public.integration_agents from public, anon, authenticated;

create table if not exists public.integration_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.integration_accounts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  operation text not null
    constraint integration_jobs_operation_format check (operation ~ '^[a-z_]+\.[a-z_]+$'),
  idempotency_key text not null
    constraint integration_jobs_key_length check (char_length(idempotency_key) between 8 and 120),
  payload jsonb not null default '{}'::jsonb
    constraint integration_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending'
    constraint integration_jobs_status_allowed check (status in ('pending', 'running', 'succeeded', 'dead')),
  attempts integer not null default 0 constraint integration_jobs_attempts_range check (attempts >= 0),
  max_attempts integer not null default 5 constraint integration_jobs_max_attempts_range check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  -- 'worker' jobs run on the server. 'agent' jobs (live printers) run on an on-site agent.
  executor text not null default 'worker'
    constraint integration_jobs_executor_allowed check (executor in ('worker', 'agent')),
  locked_by uuid references public.integration_agents (id) on delete set null,
  result jsonb not null default '{}'::jsonb
    constraint integration_jobs_result_size check (char_length(result::text) <= 4096),
  last_error_code text constraint integration_jobs_error_code_length check (last_error_code is null or char_length(last_error_code) <= 60),
  last_error text constraint integration_jobs_error_length check (last_error is null or char_length(last_error) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint integration_jobs_payload_limit check (char_length(payload::text) <= 16384),
  constraint integration_jobs_account_key_unique unique (account_id, idempotency_key)
);

create index if not exists integration_jobs_due_idx on public.integration_jobs (status, next_attempt_at);
create index if not exists integration_jobs_business_idx on public.integration_jobs (business_id, created_at desc);
create index if not exists integration_jobs_executor_due_idx on public.integration_jobs (executor, status, next_attempt_at);

alter table public.integration_jobs enable row level security;
revoke all on public.integration_jobs from public, anon, authenticated;

create table if not exists public.integration_logs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.integration_accounts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  job_id uuid references public.integration_jobs (id) on delete cascade,
  attempt_no integer constraint integration_logs_attempt_range check (attempt_no is null or attempt_no >= 1),
  operation text not null constraint integration_logs_operation_length check (char_length(operation) between 1 and 60),
  outcome text not null
    constraint integration_logs_outcome_allowed check (outcome in ('succeeded', 'retry_scheduled', 'failed', 'exhausted')),
  error_code text constraint integration_logs_error_code_length check (error_code is null or char_length(error_code) <= 60),
  error_message text constraint integration_logs_error_message_length check (error_message is null or char_length(error_message) <= 500),
  duration_ms integer constraint integration_logs_duration_range check (duration_ms is null or duration_ms >= 0),
  mode text not null constraint integration_logs_mode_allowed check (mode in ('demo', 'live')),
  created_at timestamptz not null default now(),
  constraint integration_logs_attempt_unique unique (job_id, attempt_no)
);

create index if not exists integration_logs_account_idx on public.integration_logs (account_id, created_at desc);
create index if not exists integration_logs_business_idx on public.integration_logs (business_id, created_at desc);

alter table public.integration_logs enable row level security;
revoke all on public.integration_logs from public, anon, authenticated;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.integration_accounts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider text not null constraint webhook_events_provider_length check (char_length(provider) between 2 and 40),
  mode text not null constraint webhook_events_mode_allowed check (mode in ('demo', 'live')),
  event_id text not null constraint webhook_events_event_id_length check (char_length(event_id) between 1 and 160),
  event_type text constraint webhook_events_event_type_length check (event_type is null or char_length(event_type) <= 80),
  payload_sha256 text not null
    constraint webhook_events_hash_format check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'received'
    constraint webhook_events_status_allowed check (status in ('received', 'processed', 'ignored', 'failed')),
  summary jsonb not null default '{}'::jsonb
    constraint webhook_events_summary_object check (jsonb_typeof(summary) = 'object' and char_length(summary::text) <= 4096),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint webhook_events_account_event_unique unique (account_id, event_id)
);

create index if not exists webhook_events_business_idx on public.webhook_events (business_id, received_at desc);

alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from public, anon, authenticated;

-- ── 3. Operation allow-list per provider ───────────────────────────────────

create or replace function public.integration_operation_allowed(p_provider text, p_operation text)
returns boolean
language sql
immutable
as $$
  select case p_provider
    when 'razorpay' then p_operation in ('payment.create_link')
    when 'whatsapp' then p_operation in ('message.send')
    when 'sms' then p_operation in ('message.send')
    when 'email' then p_operation in ('email.send')
    when 'printer' then p_operation in ('print.document', 'connection.test')
    when 'swiggy' then p_operation in ('aggregator.sync_menu', 'aggregator.push_status')
    when 'zomato' then p_operation in ('aggregator.sync_menu', 'aggregator.push_status')
    else false
  end;
$$;

-- ── 4. Connection save (settings + optional new ciphertext, one transaction) ──

create or replace function public.integration_account_save(
  p_actor uuid,
  p_business_id uuid,
  p_outlet_id uuid,
  p_provider text,
  p_mode text,
  p_enabled boolean,
  p_config jsonb,
  p_hints jsonb,
  p_ciphertext text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_before public.integration_accounts%rowtype;
  v_has_secret boolean;
  v_changed boolean := false;
  v_status text;
  v_scope uuid := coalesce(p_outlet_id, '00000000-0000-0000-0000-000000000000'::uuid);
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  if p_outlet_id is not null and not exists (
    select 1 from public.outlets where id = p_outlet_id and business_id = p_business_id
  ) then
    raise exception 'Outlet not found.' using errcode = 'P0001';
  end if;

  if p_provider not in ('razorpay', 'swiggy', 'zomato', 'whatsapp', 'sms', 'email', 'printer', 'accounting_export') then
    raise exception 'Unknown integration.' using errcode = 'P0001';
  end if;

  if p_provider in ('swiggy', 'zomato') and p_mode = 'live' then
    raise exception 'Live access for this provider needs partner onboarding. Use demo mode until access is granted.'
      using errcode = 'P0001';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Settings are invalid.' using errcode = 'P0001';
  end if;

  -- Defence in depth: credential-looking keys never belong in settings.
  if exists (
    select 1 from jsonb_object_keys(p_config) k
    where k ~* '(secret|token|password|api_key|key_secret|credential)'
  ) then
    raise exception 'Credentials must be entered in the credentials fields.' using errcode = 'P0001';
  end if;

  select * into v_before
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.provider = p_provider
    and coalesce(a.outlet_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope
  for update;

  if v_before.id is null then
    insert into public.integration_accounts (
      business_id, outlet_id, provider, mode, enabled, config, credential_hints, created_by, updated_by
    )
    values (
      p_business_id, p_outlet_id, p_provider, p_mode, coalesce(p_enabled, false), p_config,
      coalesce(p_hints, '{}'::jsonb), p_actor, p_actor
    )
    returning id into v_id;
    v_changed := true;
  else
    v_id := v_before.id;
    v_changed := v_before.mode is distinct from p_mode
              or v_before.config is distinct from p_config
              or p_ciphertext is not null;
    update public.integration_accounts
       set mode = p_mode,
           enabled = coalesce(p_enabled, false),
           config = p_config,
           credential_hints = case when p_ciphertext is not null then coalesce(p_hints, '{}'::jsonb) else credential_hints end,
           updated_by = p_actor,
           updated_at = now()
     where id = v_id;
  end if;

  if p_ciphertext is not null then
    insert into public.integration_secrets (account_id, ciphertext, updated_at)
    values (v_id, p_ciphertext, now())
    on conflict (account_id) do update
      set ciphertext = excluded.ciphertext, updated_at = now();
  end if;

  select exists (select 1 from public.integration_secrets s where s.account_id = v_id) into v_has_secret;

  -- Any change to settings, mode or credentials needs a fresh connection test.
  if p_mode = 'live' and p_provider <> 'printer' and not v_has_secret then
    v_status := 'not_configured';
  elsif v_before.id is null or v_changed or v_before.status = 'not_configured' then
    v_status := 'untested';
  else
    v_status := v_before.status;
  end if;

  -- Enabling needs a passing test. Saving cannot switch an untested connection on.
  update public.integration_accounts
     set status = v_status,
         last_error = case when v_changed then null else last_error end,
         enabled = case when v_status = 'connected' then enabled else false end
   where id = v_id;

  insert into public.audit_logs (
    business_id, outlet_id, actor_user_id, action, target_type, target_id,
    before_state, after_state, metadata
  )
  values (
    p_business_id, p_outlet_id, p_actor, 'integration.saved', 'integration_account', v_id::text,
    case when v_before.id is null then null
         else public.audit_scrub(jsonb_build_object('mode', v_before.mode, 'enabled', v_before.enabled, 'status', v_before.status, 'config', v_before.config)) end,
    public.audit_scrub(jsonb_build_object(
      'provider', p_provider, 'mode', p_mode,
      'enabled', (select a.enabled from public.integration_accounts a where a.id = v_id),
      'status', v_status, 'config', p_config)),
    jsonb_build_object('provider', p_provider)
  );

  if p_ciphertext is not null then
    -- Records that credentials changed. The values never reach the audit trail.
    insert into public.audit_logs (
      business_id, outlet_id, actor_user_id, action, target_type, target_id, metadata
    )
    values (
      p_business_id, p_outlet_id, p_actor, 'integration.credentials_saved', 'integration_account', v_id::text,
      jsonb_build_object('provider', p_provider)
    );
  end if;

  return v_id;
end $$;

-- ── 5. Enable / disable (enabling requires a passing test) ─────────────────

create or replace function public.integration_account_set_enabled(
  p_actor uuid,
  p_business_id uuid,
  p_account_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acc public.integration_accounts%rowtype;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  select * into v_acc from public.integration_accounts
  where id = p_account_id and business_id = p_business_id
  for update;
  if v_acc.id is null then
    raise exception 'Integration not found.' using errcode = 'P0001';
  end if;
  if p_enabled and v_acc.status <> 'connected' then
    raise exception 'Test the connection before turning this integration on.' using errcode = 'P0001';
  end if;

  update public.integration_accounts
     set enabled = p_enabled, updated_by = p_actor, updated_at = now()
   where id = p_account_id;

  insert into public.audit_logs (business_id, outlet_id, actor_user_id, action, target_type, target_id, before_state, after_state)
  values (
    p_business_id, v_acc.outlet_id, p_actor,
    case when p_enabled then 'integration.enabled' else 'integration.disabled' end,
    'integration_account', p_account_id::text,
    jsonb_build_object('enabled', v_acc.enabled),
    jsonb_build_object('enabled', p_enabled)
  );
end $$;

-- ── 6. Connection test result (written by the app after a real or demo probe) ──

create or replace function public.integration_test_result(
  p_actor uuid,
  p_business_id uuid,
  p_account_id uuid,
  p_ok boolean,
  p_error_code text,
  p_error_message text,
  p_duration_ms integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acc public.integration_accounts%rowtype;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  select * into v_acc from public.integration_accounts
  where id = p_account_id and business_id = p_business_id
  for update;
  if v_acc.id is null then
    raise exception 'Integration not found.' using errcode = 'P0001';
  end if;

  update public.integration_accounts
     set status = case when p_ok then 'connected' else 'error' end,
         last_tested_at = now(),
         last_success_at = case when p_ok then now() else last_success_at end,
         last_error = case when p_ok then null else left(coalesce(p_error_message, 'Test failed.'), 500) end,
         -- A failed test turns the integration off, so nothing runs against a broken connection.
         enabled = case when p_ok then enabled else false end,
         updated_at = now()
   where id = p_account_id;

  insert into public.integration_logs (
    account_id, business_id, operation, outcome, error_code, error_message, duration_ms, mode
  )
  values (
    p_account_id, p_business_id, 'connection.test',
    case when p_ok then 'succeeded' else 'failed' end,
    left(p_error_code, 60), left(p_error_message, 500), greatest(coalesce(p_duration_ms, 0), 0), v_acc.mode
  );
end $$;

-- ── 7. Enqueue (idempotent per account + key) ──────────────────────────────

create or replace function public.integration_enqueue(
  p_actor uuid,
  p_business_id uuid,
  p_account_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acc public.integration_accounts%rowtype;
  v_id uuid;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  select * into v_acc from public.integration_accounts
  where id = p_account_id and business_id = p_business_id;
  if v_acc.id is null then
    raise exception 'Integration not found.' using errcode = 'P0001';
  end if;
  if p_operation = 'connection.test' then
    -- The only job allowed before a passing test: a live printer's test through its agent.
    if not (v_acc.provider = 'printer' and v_acc.mode = 'live') then
      raise exception 'This action is not available for this integration.' using errcode = 'P0001';
    end if;
  else
    -- A passing test comes first; enabling comes second.
    if v_acc.status <> 'connected' then
      raise exception 'Test the connection before sending.' using errcode = 'P0001';
    end if;
    if not v_acc.enabled then
      raise exception 'Turn this integration on before sending.' using errcode = 'P0001';
    end if;
  end if;
  if not public.integration_operation_allowed(v_acc.provider, p_operation) then
    raise exception 'This action is not available for this integration.' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 120 then
    raise exception 'The request key is invalid.' using errcode = 'P0001';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'The request payload is invalid.' using errcode = 'P0001';
  end if;

  insert into public.integration_jobs (account_id, business_id, operation, idempotency_key, payload, created_by, executor)
  values (p_account_id, p_business_id, p_operation, p_idempotency_key, p_payload, p_actor,
          case when v_acc.provider = 'printer' and v_acc.mode = 'live' then 'agent' else 'worker' end)
  on conflict on constraint integration_jobs_account_key_unique do nothing
  returning id into v_id;

  if v_id is null then
    -- Same key already queued or done: return it, do not create a second send.
    select j.id into v_id from public.integration_jobs j
    where j.account_id = p_account_id and j.idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end $$;

-- ── 8. Worker: claim due jobs (lease), finish with retry or outcome ─────────

create or replace function public.integration_job_claim(
  p_limit integer,
  p_lease_seconds integer,
  p_business_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Claim limit must be between 1 and 50.' using errcode = 'P0001';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'Lease must be between 30 and 900 seconds.' using errcode = 'P0001';
  end if;

  -- A worker that died mid-job leaves a running row behind. If that job has no tries left, it is dead.
  update public.integration_jobs
     set status = 'dead',
         last_error_code = 'lease_expired',
         last_error = 'The worker stopped before this job finished.',
         locked_until = null,
         completed_at = now(),
         updated_at = now()
   where status = 'running'
     and executor = 'worker'
     and locked_until < now()
     and attempts >= max_attempts
     and (p_business_id is null or business_id = p_business_id);

  with picked as (
    select j.id
    from public.integration_jobs j
    where j.executor = 'worker'
      and (
        (j.status = 'pending' and j.next_attempt_at <= now())
        or (j.status = 'running' and j.locked_until < now())
      )
      and (p_business_id is null or j.business_id = p_business_id)
    order by j.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.integration_jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds),
           updated_at = now()
      from picked
     where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_id', c.id,
           'account_id', c.account_id,
           'business_id', c.business_id,
           'operation', c.operation,
           'payload', c.payload,
           'attempt_no', c.attempts,
           'max_attempts', c.max_attempts
         ) order by c.next_attempt_at), '[]'::jsonb)
    into v_result
    from claimed c;

  return v_result;
end $$;

create or replace function public.integration_job_finish(
  p_job_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_message text,
  p_result jsonb,
  p_retry_after_seconds integer,
  p_duration_ms integer,
  p_account_status text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.integration_jobs%rowtype;
  v_mode text;
  v_log_outcome text;
  v_delay integer;
begin
  if p_outcome not in ('succeeded', 'retry', 'failed') then
    raise exception 'Unknown outcome.' using errcode = 'P0001';
  end if;
  if p_account_status is not null and p_account_status not in ('connected', 'error') then
    raise exception 'Unknown account status.' using errcode = 'P0001';
  end if;

  select * into v_job from public.integration_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found.' using errcode = 'P0001';
  end if;
  if v_job.status <> 'running' then
    return 'ignored';
  end if;

  select a.mode into v_mode from public.integration_accounts a where a.id = v_job.account_id;

  if p_outcome = 'succeeded' then
    update public.integration_jobs
       set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb),
           last_error_code = null, last_error = null, locked_until = null,
           completed_at = now(), updated_at = now()
     where id = p_job_id;
    update public.integration_accounts
       set status = 'connected', last_success_at = now(), last_error = null, updated_at = now()
     where id = v_job.account_id;
    v_log_outcome := 'succeeded';

  elsif p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    -- Exponential backoff: 1, 2, 4, 8 … minutes, capped at 6 hours.
    v_delay := coalesce(p_retry_after_seconds, least(21600, 60 * power(2, v_job.attempts - 1)::integer));
    update public.integration_jobs
       set status = 'pending',
           next_attempt_at = now() + make_interval(secs => v_delay),
           locked_until = null,
           last_error_code = left(p_error_code, 60),
           last_error = left(p_error_message, 500),
           updated_at = now()
     where id = p_job_id;
    v_log_outcome := 'retry_scheduled';

  else
    -- Fatal error, or retries used up. The job is dead until someone retries it.
    update public.integration_jobs
       set status = 'dead',
           locked_until = null,
           last_error_code = left(p_error_code, 60),
           last_error = left(p_error_message, 500),
           completed_at = now(),
           updated_at = now()
     where id = p_job_id;
    v_log_outcome := case when p_outcome = 'retry' then 'exhausted' else 'failed' end;
    if p_account_status is not null then
      update public.integration_accounts
         set status = p_account_status,
             last_error = left(p_error_message, 500),
             updated_at = now()
       where id = v_job.account_id;
    end if;
  end if;

  insert into public.integration_logs (
    account_id, business_id, job_id, attempt_no, operation, outcome,
    error_code, error_message, duration_ms, mode
  )
  values (
    v_job.account_id, v_job.business_id, p_job_id, v_job.attempts, v_job.operation, v_log_outcome,
    left(p_error_code, 60), left(p_error_message, 500), greatest(coalesce(p_duration_ms, 0), 0), v_mode
  );

  return 'ok';
end $$;

-- ── 9. Retry a dead job (user action, audited) ─────────────────────────────

create or replace function public.integration_job_retry(
  p_actor uuid,
  p_business_id uuid,
  p_job_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.integration_jobs%rowtype;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  select * into v_job from public.integration_jobs
  where id = p_job_id and business_id = p_business_id
  for update;
  if v_job.id is null then
    raise exception 'Job not found.' using errcode = 'P0001';
  end if;
  if v_job.status <> 'dead' then
    raise exception 'Only failed jobs can be retried.' using errcode = 'P0001';
  end if;

  -- Three more tries after the ones already used. Attempt numbers keep counting up, so the log stays unique.
  update public.integration_jobs
     set status = 'pending',
         next_attempt_at = now(),
         max_attempts = attempts + 3,
         completed_at = null,
         updated_at = now()
   where id = p_job_id;

  insert into public.audit_logs (business_id, actor_user_id, action, target_type, target_id, before_state, after_state)
  values (
    p_business_id, p_actor, 'integration.job_retried', 'integration_job', p_job_id::text,
    jsonb_build_object('status', 'dead'), jsonb_build_object('status', 'pending')
  );
end $$;

-- ── 10. Inbound webhook receipt (idempotent) ───────────────────────────────

create or replace function public.integration_webhook_claim(
  p_account_id uuid,
  p_event_id text,
  p_event_type text,
  p_payload_sha256 text,
  p_summary jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acc public.integration_accounts%rowtype;
  v_inserted uuid;
  v_existing public.webhook_events%rowtype;
begin
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Payload digest is invalid.' using errcode = 'P0001';
  end if;
  if p_event_id is null or char_length(p_event_id) not between 1 and 160 then
    raise exception 'Event id is invalid.' using errcode = 'P0001';
  end if;

  select * into v_acc from public.integration_accounts where id = p_account_id;
  if v_acc.id is null then
    raise exception 'Integration not found.' using errcode = 'P0001';
  end if;

  insert into public.webhook_events (
    account_id, business_id, provider, mode, event_id, event_type, payload_sha256, summary
  )
  values (
    p_account_id, v_acc.business_id, v_acc.provider, v_acc.mode, p_event_id,
    left(p_event_type, 80), p_payload_sha256, coalesce(p_summary, '{}'::jsonb)
  )
  on conflict on constraint webhook_events_account_event_unique do nothing
  returning id into v_inserted;

  if v_inserted is not null then
    return 'new';
  end if;

  select * into v_existing from public.webhook_events
  where account_id = p_account_id and event_id = p_event_id;

  if v_existing.payload_sha256 = p_payload_sha256 then
    return 'duplicate';
  end if;
  return 'mismatch';
end $$;

-- ── 10b. Runtime load: the worker and the webhook receiver read an account and its ciphertext. ──
-- Service role only. The ciphertext is returned only to this call, never to a client.

create or replace function public.integration_runtime_load(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc public.integration_accounts%rowtype;
  v_cipher text;
begin
  select * into v_acc from public.integration_accounts where id = p_account_id;
  if not found then
    raise exception 'Integration not found.' using errcode = 'P0002';
  end if;

  select s.ciphertext into v_cipher from public.integration_secrets s where s.account_id = p_account_id;

  return jsonb_build_object(
    'account_id', v_acc.id,
    'business_id', v_acc.business_id,
    'outlet_id', v_acc.outlet_id,
    'provider', v_acc.provider,
    'mode', v_acc.mode,
    'enabled', v_acc.enabled,
    'status', v_acc.status,
    'config', v_acc.config,
    'ciphertext', v_cipher
  );
end $$;

-- ── 10c. Settings panel read: settings managers only. Never returns ciphertext or job payloads. ──

create or replace function public.integration_panel_load(p_actor uuid, p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  return jsonb_build_object(
    'accounts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id,
        'provider', a.provider,
        'mode', a.mode,
        'enabled', a.enabled,
        'status', a.status,
        'outlet_id', a.outlet_id,
        'config', a.config,
        'credential_hints', a.credential_hints,
        'last_tested_at', a.last_tested_at,
        'last_success_at', a.last_success_at,
        'last_error', a.last_error
      ) order by a.provider, a.outlet_id nulls first), '[]'::jsonb)
      from public.integration_accounts a
      where a.business_id = p_business_id
    ),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', j.id,
        'account_id', j.account_id,
        'operation', j.operation,
        'status', j.status,
        'attempts', j.attempts,
        'max_attempts', j.max_attempts,
        'next_attempt_at', j.next_attempt_at,
        'last_error_code', j.last_error_code,
        'last_error', j.last_error,
        'created_at', j.created_at
      ) order by j.created_at desc), '[]'::jsonb)
      from (
        select * from public.integration_jobs
        where business_id = p_business_id
        order by created_at desc
        limit 20
      ) j
    ),
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id,
        'outlet_id', g.outlet_id,
        'name', g.name,
        'created_at', g.created_at,
        'last_seen_at', g.last_seen_at,
        'revoked_at', g.revoked_at
      ) order by g.created_at), '[]'::jsonb)
      from public.integration_agents g
      where g.business_id = p_business_id
    ),
    'logs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id,
        'account_id', l.account_id,
        'job_id', l.job_id,
        'attempt_no', l.attempt_no,
        'operation', l.operation,
        'outcome', l.outcome,
        'error_code', l.error_code,
        'error_message', l.error_message,
        'mode', l.mode,
        'created_at', l.created_at
      ) order by l.created_at desc), '[]'::jsonb)
      from (
        select * from public.integration_logs
        where business_id = p_business_id
        order by created_at desc
        limit 30
      ) l
    )
  );
end $$;

-- ── 10d. Print agents: register and revoke (settings managers), claim and report (agent token) ──
-- The token itself never reaches the database: callers pass its SHA-256 hex digest.

create or replace function public.integration_agent_register(
  p_actor uuid,
  p_business_id uuid,
  p_outlet_id uuid,
  p_name text,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  if p_outlet_id is null or not exists (
    select 1 from public.outlets o where o.id = p_outlet_id and o.business_id = p_business_id
  ) then
    raise exception 'Outlet not found.' using errcode = 'P0001';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 60 then
    raise exception 'Name the agent (up to 60 characters).' using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The agent token is invalid.' using errcode = 'P0001';
  end if;

  insert into public.integration_agents (business_id, outlet_id, name, token_hash, created_by)
  values (p_business_id, p_outlet_id, trim(p_name), p_token_hash, p_actor)
  returning id into v_id;

  insert into public.audit_logs (business_id, outlet_id, actor_user_id, action, target_type, target_id, metadata)
  values (p_business_id, p_outlet_id, p_actor, 'integration.agent_registered', 'integration_agent', v_id,
          jsonb_build_object('name', trim(p_name)));

  return v_id;
end $$;

create or replace function public.integration_agent_revoke(
  p_actor uuid,
  p_business_id uuid,
  p_agent_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.integration_agents%rowtype;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');

  select * into v_agent from public.integration_agents
  where id = p_agent_id and business_id = p_business_id
  for update;
  if v_agent.id is null then
    raise exception 'Agent not found.' using errcode = 'P0001';
  end if;
  if v_agent.revoked_at is not null then
    return;
  end if;

  update public.integration_agents set revoked_at = now() where id = v_agent.id;

  insert into public.audit_logs (business_id, outlet_id, actor_user_id, action, target_type, target_id, metadata)
  values (p_business_id, v_agent.outlet_id, p_actor, 'integration.agent_revoked', 'integration_agent', v_agent.id,
          jsonb_build_object('name', v_agent.name));
end $$;

-- Agent claim: returns due agent jobs for this agent's outlet. Printer host and paper width come from the
-- account config. The payload is returned so the server can build the ESC/POS bytes.
create or replace function public.integration_agent_claim(
  p_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.integration_agents%rowtype;
  v_result jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Agent not recognised.' using errcode = 'P0002';
  end if;
  select * into v_agent from public.integration_agents
  where token_hash = p_token_hash and revoked_at is null;
  if v_agent.id is null then
    raise exception 'Agent not recognised.' using errcode = 'P0002';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'Claim limit must be between 1 and 10.' using errcode = 'P0001';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'Lease must be between 30 and 900 seconds.' using errcode = 'P0001';
  end if;

  update public.integration_agents set last_seen_at = now() where id = v_agent.id;

  -- An agent that died mid-job with no tries left: the job is dead.
  update public.integration_jobs j
     set status = 'dead',
         last_error_code = 'lease_expired',
         last_error = 'The print agent stopped before this job finished.',
         locked_until = null,
         locked_by = null,
         completed_at = now(),
         updated_at = now()
   where j.executor = 'agent'
     and j.status = 'running'
     and j.locked_until < now()
     and j.attempts >= j.max_attempts
     and j.account_id in (select a.id from public.integration_accounts a where a.outlet_id = v_agent.outlet_id);

  with picked as (
    select j.id
    from public.integration_jobs j
    join public.integration_accounts a on a.id = j.account_id
    where j.executor = 'agent'
      and a.outlet_id = v_agent.outlet_id
      and a.business_id = v_agent.business_id
      and (
        (j.status = 'pending' and j.next_attempt_at <= now())
        or (j.status = 'running' and j.locked_until < now())
      )
      -- Only the connection test may run before the printer passes its test.
      and (j.operation = 'connection.test' or (a.enabled and a.status = 'connected'))
    order by j.next_attempt_at
    limit p_limit
    for update of j skip locked
  ),
  claimed as (
    update public.integration_jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds),
           locked_by = v_agent.id,
           updated_at = now()
      from picked
     where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_id', c.id,
           'operation', c.operation,
           'attempt_no', c.attempts,
           'max_attempts', c.max_attempts,
           'payload', c.payload,
           'host', a.config->>'host',
           'paper_width_chars', (a.config->>'paper_width_chars')::integer
         ) order by c.next_attempt_at), '[]'::jsonb)
    into v_result
    from claimed c
    join public.integration_accounts a on a.id = c.account_id;

  return v_result;
end $$;

-- Agent report: finishes a job this agent claimed. Account effects follow the same rules as the worker.
create or replace function public.integration_agent_report(
  p_token_hash text,
  p_job_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_message text,
  p_duration_ms integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.integration_agents%rowtype;
  v_job public.integration_jobs%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Agent not recognised.' using errcode = 'P0002';
  end if;
  select * into v_agent from public.integration_agents
  where token_hash = p_token_hash and revoked_at is null;
  if v_agent.id is null then
    raise exception 'Agent not recognised.' using errcode = 'P0002';
  end if;

  if p_outcome not in ('succeeded', 'retry', 'failed') then
    raise exception 'Unknown outcome.' using errcode = 'P0001';
  end if;

  select * into v_job from public.integration_jobs where id = p_job_id for update;
  if v_job.id is null
     or v_job.executor <> 'agent'
     or v_job.locked_by is distinct from v_agent.id
     or not exists (
       select 1 from public.integration_accounts a
       where a.id = v_job.account_id and a.outlet_id = v_agent.outlet_id
     ) then
    raise exception 'This job is not claimed by this agent.' using errcode = 'P0001';
  end if;
  if v_job.status <> 'running' then
    return 'ignored';
  end if;

  update public.integration_jobs set locked_by = null where id = p_job_id;

  if v_job.operation = 'connection.test' then
    update public.integration_accounts set last_tested_at = now(), updated_at = now() where id = v_job.account_id;
  end if;

  return public.integration_job_finish(
    p_job_id,
    p_outcome,
    p_error_code,
    p_error_message,
    '{}'::jsonb,
    null,
    p_duration_ms,
    case when p_outcome = 'failed' then 'error' else null end
  );
end $$;

-- ── 11. Grants: service role only. Users reach these through the app's actor checks. ──

revoke all on function public.integration_operation_allowed(text, text) from public, anon, authenticated;
grant execute on function public.integration_operation_allowed(text, text) to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'integration_account_save(uuid, uuid, uuid, text, text, boolean, jsonb, jsonb, text)',
    'integration_account_set_enabled(uuid, uuid, uuid, boolean)',
    'integration_test_result(uuid, uuid, uuid, boolean, text, text, integer)',
    'integration_enqueue(uuid, uuid, uuid, text, text, jsonb)',
    'integration_job_claim(integer, integer, uuid)',
    'integration_job_finish(uuid, text, text, text, jsonb, integer, integer, text)',
    'integration_job_retry(uuid, uuid, uuid)',
    'integration_webhook_claim(uuid, text, text, text, jsonb)',
    'integration_runtime_load(uuid)',
    'integration_panel_load(uuid, uuid)',
    'integration_agent_register(uuid, uuid, uuid, text, text)',
    'integration_agent_revoke(uuid, uuid, uuid)',
    'integration_agent_claim(text, integer, integer)',
    'integration_agent_report(text, uuid, text, text, text, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
