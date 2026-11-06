-- 0025_wording.sql
-- Professional wording pass ("Wording and tone" in CLAUDE.md): two final-check
-- messages from 0020 used the word "tick". Same functions, same behaviour,
-- new words only.

create or replace function public.checklist_items_guard()
returns trigger
language plpgsql
as $$
begin
  if public.is_system_change() then
    return new;
  end if;
  if exists (select 1 from public.machine_checklists c where c.id = old.checklist_id and c.signed_at is not null) then
    raise exception 'This final check is signed and locked. Ask an administrator to unlock it.' using errcode = '42501';
  end if;
  if new.checklist_id is distinct from old.checklist_id or new.section is distinct from old.section
     or new.item_text is distinct from old.item_text or new.sort_order is distinct from old.sort_order
     or new.template_item_id is distinct from old.template_item_id or new.is_one_off is distinct from old.is_one_off
     or new.added_by_name is distinct from old.added_by_name then
    raise exception 'Only the status and notes of a checklist item can be changed.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'open' then
      new.status_by_name := null;
      new.status_at := null;
    else
      new.status_by_name := public.current_user_name();
      new.status_at := now();
    end if;
  else
    new.status_by_name := old.status_by_name;
    new.status_at := old.status_at;
  end if;
  if new.notes is distinct from old.notes then
    new.notes := nullif(btrim(new.notes), '');
    new.notes_by_name := public.current_user_name();
    new.notes_at := now();
  else
    new.notes_by_name := old.notes_by_name;
    new.notes_at := old.notes_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.sign_checklist(p_checklist_id uuid, p_full_name text, p_signature_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c    record;
  v_open integer;
begin
  perform public.require_perm('checklist.sign');
  select * into v_c from public.machine_checklists where id = p_checklist_id;
  if v_c.id is null then
    raise exception 'That checklist could not be found.';
  end if;
  if v_c.signed_at is not null then
    raise exception 'This final check is already signed.';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) < 3 then
    raise exception 'Enter your full name to sign.';
  end if;
  select count(*) into v_open from public.machine_checklist_items where checklist_id = p_checklist_id and status = 'open';
  if v_open > 0 then
    raise exception '% item% still need% to be marked complete or not applicable before signing.', v_open, case when v_open = 1 then '' else 's' end, case when v_open = 1 then 's' else '' end;
  end if;
  if p_signature_path is null or p_signature_path not like p_checklist_id::text || '/%'
     or not exists (select 1 from storage.objects o
                     where o.bucket_id = 'checklist-signatures' and o.name = p_signature_path) then
    raise exception 'The signature was not saved. Please sign again.';
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.machine_checklists
     set signed_name = btrim(p_full_name), signed_at = now(), signed_by = public.current_user_email(),
         signature_path = p_signature_path, last_worked_at = now(), last_worked_by_name = public.current_user_name()
   where id = p_checklist_id;
  update public.order_machines set checklist_done = true where id = v_c.machine_id;
end;
$$;

-- Access lockdown, as in earlier migrations.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.can_sign_in(text) to anon;
revoke execute on function public.admin_auth_user_id(text) from authenticated;
grant execute on function public.admin_auth_user_id(text) to service_role;
