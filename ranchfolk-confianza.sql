-- RANCHFOLK: confianza en La Feria. Video en vivo, tratos confirmados, historial del vendedor
-- y "Ganadero verificado". Se puede correr más de una vez.

-- 1. Video grabado en vivo dentro de Ranchfolk (la fecha la pone la base de datos, no el teléfono)
alter table public.listings add column if not exists live_video text;
alter table public.listings add column if not exists live_at timestamptz;
create or replace function public.listing_live_stamp() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.live_video is null then new.live_at := null;
  elsif tg_op = 'INSERT' or new.live_video is distinct from old.live_video then
    if auth.uid() is not null and (position('/media/' || auth.uid()::text || '/' in new.live_video) = 0 or not (new.live_video = any(coalesce(new.photos, '{}')))) then
      raise exception 'video en vivo no válido';
    end if;
    new.live_at := now();
  else new.live_at := old.live_at; end if;
  return new;
end $$;
drop trigger if exists listings_live_stamp on public.listings;
create trigger listings_live_stamp before insert or update on public.listings for each row execute function public.listing_live_stamp();

-- 2. Tratos: el vendedor dice a quién le vendió y el comprador confirma
create table if not exists public.deals (
  id bigint generated always as identity primary key,
  listing_id bigint references public.listings(id) on delete set null,
  listing_title text not null,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  buyer_answer text check (buyer_answer in ('si', 'no')),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  check (seller_id <> buyer_id),
  unique (listing_id, buyer_id)
);
create index if not exists deals_buyer_idx on public.deals(buyer_id) where buyer_answer is null;
create index if not exists deals_seller_idx on public.deals(seller_id);
alter table public.deals enable row level security;
drop policy if exists "ver mis tratos" on public.deals;
create policy "ver mis tratos" on public.deals for select to authenticated using (auth.uid() in (seller_id, buyer_id));

create or replace function public.deal_create(lid bigint, buyer uuid) returns bigint language plpgsql security definer set search_path = '' as $$
declare l public.listings; did bigint;
begin
  select * into l from public.listings where id = lid;
  if l.id is null or l.user_id <> auth.uid() then raise exception 'no es tu anuncio'; end if;
  if buyer = auth.uid() then raise exception 'no puedes ser tu propio comprador'; end if;
  if not public.talked_with(buyer) then raise exception 'solo con alguien con quien platicaste'; end if;
  insert into public.deals (listing_id, listing_title, seller_id, buyer_id) values (lid, l.title, auth.uid(), buyer)
    on conflict (listing_id, buyer_id) do update set created_at = now() returning id into did;
  return did;
end $$;
grant execute on function public.deal_create(bigint, uuid) to authenticated;

create or replace function public.deal_answer(did bigint, ok boolean) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.deals set buyer_answer = case when ok then 'si' else 'no' end, answered_at = now()
   where id = did and buyer_id = auth.uid();
end $$;
grant execute on function public.deal_answer(bigint, boolean) to authenticated;

-- 3. Historial del vendedor (lo ve cualquiera)
alter table public.profiles add column if not exists ganadero boolean not null default false;
create or replace function public.seller_stats(uid uuid) returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'since', (select created_at from public.profiles where id = uid),
    'listings', (select count(*) from public.listings where user_id = uid),
    'sold', (select count(*) from public.listings where user_id = uid and status = 'vendido'),
    'deals_ok', (select count(*) from public.deals where seller_id = uid and buyer_answer = 'si'),
    'ganadero', (select ganadero from public.profiles where id = uid));
$$;
grant execute on function public.seller_stats(uuid) to authenticated, anon;

-- 4. Ganadero verificado: solo un administrador lo puede marcar
create or replace function public.keep_ganadero() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.ganadero := case when tg_op = 'INSERT' then false else old.ganadero end;
  end if;
  return new;
end $$;
drop trigger if exists profiles_keep_ganadero on public.profiles;
create trigger profiles_keep_ganadero before insert or update on public.profiles for each row execute function public.keep_ganadero();

create table if not exists public.rancher_requests (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  upp text check (upp is null or char_length(upp) <= 40),
  siniiga text check (siniiga is null or char_length(siniiga) <= 60),
  asociacion text check (asociacion is null or char_length(asociacion) <= 120),
  municipio text check (municipio is null or char_length(municipio) <= 80),
  docs text[] not null default '{}' check (cardinality(docs) <= 6),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobado', 'rechazado')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.rancher_requests enable row level security;
drop policy if exists "ver mi solicitud" on public.rancher_requests;
create policy "ver mi solicitud" on public.rancher_requests for select to authenticated using (auth.uid() = user_id);
drop policy if exists "mandar mi solicitud" on public.rancher_requests;
create policy "mandar mi solicitud" on public.rancher_requests for insert to authenticated with check (auth.uid() = user_id and not public.is_banned(auth.uid()));
drop policy if exists "cambiar mi solicitud" on public.rancher_requests;
create policy "cambiar mi solicitud" on public.rancher_requests for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Al mandarla o cambiarla, vuelve a "pendiente"; solo el administrador la aprueba
create or replace function public.keep_rancher_status() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.status := 'pendiente'; new.note := null; new.reviewed_at := null; new.updated_at := now();
    if tg_op = 'UPDATE' and old.status = 'aprobado' then raise exception 'ya estás verificado'; end if;
  end if;
  return new;
end $$;
drop trigger if exists rancher_requests_keep on public.rancher_requests;
create trigger rancher_requests_keep before insert or update on public.rancher_requests for each row execute function public.keep_rancher_status();

-- Papeles: carpeta privada, solo los ve su dueño y los administradores
insert into storage.buckets (id, name, public) values ('verif', 'verif', false) on conflict (id) do nothing;
drop policy if exists "verif subir" on storage.objects;
create policy "verif subir" on storage.objects for insert to authenticated with check (bucket_id = 'verif' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "verif ver" on storage.objects;
create policy "verif ver" on storage.objects for select to authenticated using (bucket_id = 'verif' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists "verif borrar" on storage.objects;
create policy "verif borrar" on storage.objects for delete to authenticated using (bucket_id = 'verif' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

create or replace function public.admin_rancher_requests(st text default 'pendiente') returns table (
  user_id uuid, username text, full_name text, avatar_url text, estado text, upp text, siniiga text, asociacion text, municipio text,
  docs text[], status text, note text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'solo administradores'; end if;
  return query select r.user_id, p.username, p.full_name, p.avatar_url, p.estado, r.upp, r.siniiga, r.asociacion, r.municipio,
    r.docs, r.status, r.note, r.created_at, r.updated_at
    from public.rancher_requests r join public.profiles p on p.id = r.user_id
    where st is null or r.status = st order by r.updated_at desc limit 200;
end $$;
grant execute on function public.admin_rancher_requests(text) to authenticated;

create or replace function public.admin_rancher_decide(uid uuid, ok boolean, why text default null) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'solo administradores'; end if;
  update public.rancher_requests set status = case when ok then 'aprobado' else 'rechazado' end, note = why, reviewed_at = now() where user_id = uid;
  update public.profiles set ganadero = ok where id = uid;
end $$;
grant execute on function public.admin_rancher_decide(uuid, boolean, text) to authenticated;
