-- Park Sinyal: boşalan park yeri sinyalleri
--
-- Akış:
--   1. Park yerinden çıkan sürücünün telefonu publish_signal() çağırır  -> status = 'active'
--   2. Yer arayan kullanıcı haritada görür, claim_signal() ile "gidiyorum" der -> 'claimed'
--      (başkaları yerin sahiplenildiğini görür, aynı yere birden fazla kişi gitmez)
--   3. Varınca finish_claim(parked => true) -> 'taken', yer doluysa (false) -> 'gone'
--   Sinyaller expires_at sonrasında kendiliğinden görünmez olur.

create extension if not exists postgis with schema extensions;

create table public.parking_signals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  lat             double precision not null check (lat between -90 and 90),
  lng             double precision not null check (lng between -180 and 180),
  location        extensions.geography(point, 4326)
                    generated always as (extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography) stored,
  source          text not null default 'auto' check (source in ('auto', 'manual')),
  -- 0 = şu an boşaldı, >0 = "X dk sonra çıkıyorum"
  leaving_in_min  smallint not null default 0 check (leaving_in_min between 0 and 30),
  status          text not null default 'active'
                    check (status in ('active', 'claimed', 'taken', 'gone', 'cancelled')),
  claimed_by      uuid references auth.users (id) on delete set null,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index parking_signals_location_idx on public.parking_signals using gist (location);
create index parking_signals_live_idx on public.parking_signals (expires_at) where status in ('active', 'claimed');
create index parking_signals_user_idx on public.parking_signals (user_id, created_at desc);

alter table public.parking_signals enable row level security;
-- Realtime UPDATE olaylarında eski satırın da gelmesi için
alter table public.parking_signals replica identity full;

-- Okuma: canlı sinyaller herkese, kendi sinyallerin sana açık.
-- Yazma doğrudan yapılamaz; aşağıdaki RPC'ler (security definer) üzerinden yapılır.
create policy "canlı sinyalleri herkes görür"
  on public.parking_signals for select to authenticated
  using (
    (status in ('active', 'claimed') and expires_at > now())
    or user_id = auth.uid()
    or claimed_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Yardımcı: istemciye döndürülen satır biçimi (kimlik bilgisi sızdırmaz)
-- ---------------------------------------------------------------------------
create type public.signal_view as (
  id uuid,
  lat double precision,
  lng double precision,
  source text,
  leaving_in_min smallint,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  distance_m double precision,
  is_mine boolean,
  claimed_by_me boolean
);

-- ---------------------------------------------------------------------------
-- Yakındaki canlı sinyaller
-- ---------------------------------------------------------------------------
create or replace function public.nearby_signals(p_lat double precision, p_lng double precision, p_radius_m integer default 2000)
returns setof public.signal_view
language sql stable security invoker
set search_path = public, extensions
as $$
  select s.id, s.lat, s.lng, s.source, s.leaving_in_min, s.status, s.created_at, s.expires_at,
         st_distance(s.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography) as distance_m,
         s.user_id = auth.uid(),
         coalesce(s.claimed_by = auth.uid(), false)
  from public.parking_signals s
  where s.status in ('active', 'claimed')
    and s.expires_at > now()
    and st_dwithin(s.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, least(greatest(p_radius_m, 100), 10000))
  order by distance_m
  limit 200;
$$;

-- ---------------------------------------------------------------------------
-- Sinyal yayınla (park yerinden çıkan sürücü)
-- ---------------------------------------------------------------------------
create or replace function public.publish_signal(
  p_lat double precision,
  p_lng double precision,
  p_source text default 'auto',
  p_leaving_in_min integer default 0
)
returns public.parking_signals
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.parking_signals;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Kötüye kullanım sınırı: saatte en fazla 6 sinyal
  if (select count(*) from public.parking_signals
      where user_id = v_uid and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- Bir kullanıcının aynı anda tek canlı sinyali olur
  update public.parking_signals
     set status = 'cancelled'
   where user_id = v_uid and status = 'active';

  insert into public.parking_signals (user_id, lat, lng, source, leaving_in_min, expires_at)
  values (
    v_uid, p_lat, p_lng, coalesce(p_source, 'auto'), coalesce(p_leaving_in_min, 0)::smallint,
    -- boşalan yer ~10 dk içinde dolar; "X dk sonra çıkıyorum" ise o süre kadar uzat
    now() + make_interval(mins => 10 + coalesce(p_leaving_in_min, 0))
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Kendi sinyalini geri al (yanlış algılama vb.)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_signal(p_id uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.parking_signals
     set status = 'cancelled'
   where id = p_id and user_id = auth.uid() and status in ('active', 'claimed');
$$;

-- ---------------------------------------------------------------------------
-- "Gidiyorum": yeri sahiplen (aynı anda tek kişi)
-- ---------------------------------------------------------------------------
create or replace function public.claim_signal(p_id uuid)
returns public.parking_signals
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.parking_signals;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Önceki sahiplenmeyi bırak: aynı anda tek yere gidilir
  update public.parking_signals
     set status = 'active', claimed_by = null, claimed_at = null
   where claimed_by = v_uid and status = 'claimed' and id <> p_id;

  update public.parking_signals
     set status = 'claimed', claimed_by = v_uid, claimed_at = now(),
         expires_at = greatest(expires_at, now() + interval '10 minutes')
   where id = p_id and status = 'active' and expires_at > now() and user_id <> v_uid
  returning * into v_row;

  if v_row.id is null then
    raise exception 'signal_unavailable' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sahiplenmeyi sonlandır: park ettim (taken) / yer doluydu (gone) / vazgeçtim (null)
-- ---------------------------------------------------------------------------
create or replace function public.finish_claim(p_id uuid, p_parked boolean)
returns void
language sql security definer
set search_path = public
as $$
  update public.parking_signals
     set status     = case when p_parked is true then 'taken'
                           when p_parked is false then 'gone'
                           else 'active' end,
         claimed_by = case when p_parked is null then null else claimed_by end,
         claimed_at = case when p_parked is null then null else claimed_at end
   where id = p_id and claimed_by = auth.uid() and status = 'claimed';
$$;

revoke all on function public.publish_signal(double precision, double precision, text, integer) from public, anon;
revoke all on function public.cancel_signal(uuid) from public, anon;
revoke all on function public.claim_signal(uuid) from public, anon;
revoke all on function public.finish_claim(uuid, boolean) from public, anon;
revoke all on function public.nearby_signals(double precision, double precision, integer) from public, anon;
grant execute on function public.publish_signal(double precision, double precision, text, integer) to authenticated;
grant execute on function public.cancel_signal(uuid) to authenticated;
grant execute on function public.claim_signal(uuid) to authenticated;
grant execute on function public.finish_claim(uuid, boolean) to authenticated;
grant execute on function public.nearby_signals(double precision, double precision, integer) to authenticated;

-- Doğrudan tablo yazımı kapalı; okuma RLS ile.
revoke insert, update, delete on public.parking_signals from anon, authenticated;
revoke all on public.parking_signals from anon;
grant select on public.parking_signals to authenticated;

-- Canlı güncellemeler (yeni sinyal / sahiplenildi / iptal) istemcilere anında gitsin
alter publication supabase_realtime add table public.parking_signals;
