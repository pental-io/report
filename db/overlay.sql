-- reporter-overlay: 2
-- ═══════════════════════════════════════════════════════════════════════════
-- PENTAL REPORT'S DIFFERENCES FROM PENTAL'S TENANT SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════
-- db/schema.sql is Pental's own tenant schema, unchanged. This file is applied
-- after it, in the same transaction, every time the server applies it.
--
-- SPDX-License-Identifier: AGPL-3.0-only

-- The first administrator is made by the server, with the setup token from
-- .env (server/lib/setup.js), and never by an anonymous call: on Pental the
-- provisioning service makes it in the same moment the database is set up,
-- but Pental Report can sit set up and waiting for its first sign-in for days.
REVOKE EXECUTE ON FUNCTION public.rpc_bootstrap_admin(text, text, text) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0.1.52: A SECOND FACTOR WHERE THE FIRM ASKS FOR ONE
-- ═══════════════════════════════════════════════════════════════════════════
-- Pental's portal asks everyone for a second factor. Pental Report asks where
-- an administrator requires one (Settings, Security: Require a second
-- factor): off on a new install, on for an install that was already running
-- when it updated to this. With it off, a password is enough for anyone who
-- has not set up a second factor of their own: right after their password
-- sign-in, their session is recorded as fresh (rpc_report_password_enough,
-- through _stamp_mfa_verified, as a code records it), so every rule that
-- reads freshness holds for it as it does for a code: how long a session
-- lasts idle, a day at most, a session signed out being over. Anyone who has
-- set up an authenticator or a passkey still proves it. A session an API
-- key's exchange signed in is never a password's (the server records it as
-- the key's: server/lib/auth), so a key stays a key.
--
-- The setting. Unset on a database from before this (NULL), and set once,
-- here: on (true) where somebody already has an account, off (false) on a
-- new database, where nobody has one yet. A row made later (provisioning
-- makes the settings row again) is off, by the column's default.
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS report_mfa_required boolean;
-- (Set as the switch sets it: the row's guard, below, is there already when
-- this runs again.)
SELECT set_config('pental.report_mfa_switch', 'on', true);
UPDATE public.settings SET report_mfa_required = EXISTS (SELECT 1 FROM public.profiles)
 WHERE report_mfa_required IS NULL;
SELECT set_config('pental.report_mfa_switch', '', true);
ALTER TABLE public.settings ALTER COLUMN report_mfa_required SET DEFAULT false;
-- Readable as the schema makes every other column that is not a secret (its
-- grant is made from the columns there are, before this one exists).
GRANT SELECT (report_mfa_required) ON public.settings TO authenticated;
COMMENT ON COLUMN public.settings.report_mfa_required IS
  'Pental Report: whether everyone proves a second factor (true), or a password is enough for anyone who has set none up (false). Changed by an administrator through rpc_report_set_mfa_required alone.';

-- Changed by an administrator alone (a senior tester saves the settings row
-- too): any other write leaves it as it was.
CREATE OR REPLACE FUNCTION public._report_mfa_required_kept() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $rpkept$
BEGIN
  IF NEW.report_mfa_required IS DISTINCT FROM OLD.report_mfa_required
     AND COALESCE(current_setting('pental.report_mfa_switch', true), '') <> 'on'
     AND COALESCE(current_setting('pental.bypass_protect', true), '') <> 'true' THEN
    NEW.report_mfa_required := OLD.report_mfa_required;
  END IF;
  RETURN NEW;
END $rpkept$;
REVOKE ALL ON FUNCTION public._report_mfa_required_kept() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS report_mfa_required_kept ON public.settings;
CREATE TRIGGER report_mfa_required_kept BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public._report_mfa_required_kept();

-- Whether this firm requires a second factor: true unless an administrator
-- has turned it off.
CREATE OR REPLACE FUNCTION public.rpc_report_mfa_required() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $rpreq$
  SELECT COALESCE((SELECT s.report_mfa_required FROM public.settings s ORDER BY s.created_at ASC NULLS LAST, s.id LIMIT 1), true);
$rpreq$;
REVOKE ALL ON FUNCTION public.rpc_report_mfa_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_report_mfa_required() TO authenticated, service_role;

-- An administrator turns it on or off, with their own second factor (or,
-- where none is required, their password sign-in) fresh. Recorded.
CREATE OR REPLACE FUNCTION public.rpc_report_set_mfa_required(p_on boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp AS $rpset$
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an administrator can change whether a second factor is required.' USING ERRCODE = '42501';
  END IF;
  PERFORM public._need_fresh_mfa();
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Say whether a second factor is required: on or off.' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('pental.report_mfa_switch', 'on', true);
  UPDATE public.settings SET report_mfa_required = p_on;
  PERFORM set_config('pental.report_mfa_switch', '', true);
  INSERT INTO public._pental_rpc_audit_log (op, auth_mode, result, error_short)
  VALUES ('report_mfa_required', 'admin', 'ok', CASE WHEN p_on THEN 'on' ELSE 'off' END || ' by ' || auth.uid()::text);
  RETURN jsonb_build_object('ok', true, 'required', p_on);
END $rpset$;
REVOKE ALL ON FUNCTION public.rpc_report_set_mfa_required(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_report_set_mfa_required(boolean) TO authenticated;

-- Right after a password sign-in, where no second factor is required: the
-- session is recorded as fresh, as a code would record it. Only this
-- person's own session, begun with a password (never an API key's) in the
-- last five minutes, of a person who is active and has set up neither an
-- authenticator nor a passkey. { ok } or { ok: false, reason }.
CREATE OR REPLACE FUNCTION public.rpc_report_password_enough() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_catalog, pg_temp AS $rppw$
DECLARE
  v_uid uuid := auth.uid();
  v_sid text;
  v_made timestamptz;
  v_method text;
  v_totp boolean;
  v_keys integer;
  v_active boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  IF public.rpc_report_mfa_required() THEN RETURN jsonb_build_object('ok', false, 'reason', 'required'); END IF;
  BEGIN
    v_sid := auth.jwt() ->> 'session_id';
  EXCEPTION WHEN OTHERS THEN v_sid := NULL; END;
  IF v_sid IS NULL OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_session');
  END IF;
  -- Already recorded (asked twice): so it is.
  IF EXISTS (SELECT 1 FROM public._mfa_fresh WHERE session_id = v_sid::uuid AND auth_user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  SELECT s.created_at INTO v_made FROM auth.sessions s WHERE s.id = v_sid::uuid AND s.user_id = v_uid;
  IF v_made IS NULL OR v_made < now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session');
  END IF;
  SELECT c.authentication_method INTO v_method FROM auth.mfa_amr_claims c
   WHERE c.session_id = v_sid::uuid ORDER BY c.created_at ASC LIMIT 1;
  IF v_method IS DISTINCT FROM 'password'
     OR EXISTS (SELECT 1 FROM public.api_key_sessions k WHERE k.session_id = v_sid::uuid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'method');
  END IF;
  SELECT bool_and(p.active), bool_or(p.totp_secret IS NOT NULL AND length(p.totp_secret) > 0)
    INTO v_active, v_totp
    FROM public.profiles p WHERE p.auth_user_id = v_uid;
  IF v_active IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok', false, 'reason', 'inactive'); END IF;
  SELECT count(*) INTO v_keys FROM public.webauthn_credentials w WHERE w.auth_user_id = v_uid;
  IF COALESCE(v_totp, false) OR v_keys > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'has_factor');
  END IF;
  PERFORM public._stamp_mfa_verified(v_uid);
  RETURN jsonb_build_object('ok', true);
END $rppw$;
REVOKE ALL ON FUNCTION public.rpc_report_password_enough() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_report_password_enough() TO authenticated;
