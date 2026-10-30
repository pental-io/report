-- ═══════════════════════════════════════════════════════════════════════════
-- THE GATEWAY'S OWN FOUNDATIONS ON A PLAIN POSTGRES.
--
-- Run by the gateway as the owner on every start, before anything else, and
-- again after the portal schema is applied. Idempotent throughout: every
-- statement can run a hundred times and leaves the same database.
--
-- It gives byo-setup.sql what it takes for granted on Supabase, under the
-- same names, so that file runs unchanged and every policy and function in it
-- reads exactly as it does there:
--
--   extensions.*   pgcrypto (digest, hmac, crypt, gen_salt, pgp_sym_*,
--                  gen_random_bytes) and uuid-ossp where the server has it
--   the roles      anon, authenticated, service_role, supabase_auth_admin
--   auth.*         the users, identities, sessions, refresh tokens and MFA
--                  tables in GoTrue's shape, and auth.uid() / jwt() / role()
--                  reading the request settings the gateway sets
--   storage.*      buckets and objects as Supabase Storage keeps them, plus
--                  the tables the gateway keeps file bytes in
--   vault.*        create_secret, update_secret and decrypted_secrets, sealed
--                  with pgcrypto under the key the gateway holds
--   pental.*       the gateway's own state, and the triggers that carry live
--                  changes to the portal
-- ═══════════════════════════════════════════════════════════════════════════

-- ── extensions ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
DO $ext$
DECLARE v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
  IF v_schema IS NULL THEN
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  ELSIF v_schema <> 'extensions' THEN
    -- Installed somewhere else by hand: move it, as the schema calls it by
    -- its Supabase name.
    BEGIN
      ALTER EXTENSION pgcrypto SET SCHEMA extensions;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'pgcrypto is installed in schema % and could not be moved to "extensions": %', v_schema, SQLERRM;
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'uuid-ossp') THEN
    SELECT n.nspname INTO v_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'uuid-ossp';
    IF v_schema IS NULL THEN
      BEGIN CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions; EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END IF;
END $ext$;
-- Without uuid-ossp, the one function the schema calls from it.
DO $u$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'extensions' AND p.proname = 'uuid_generate_v4') THEN
    CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v4') THEN
    CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()';
  END IF;
END $u$;

-- ── roles ──────────────────────────────────────────────────────────────────
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT; END IF;
  -- The owner switches to them for each request, so it takes them on with
  -- the SET option (a role's creator gets ADMIN alone on PostgreSQL 16). When
  -- another user of this server made the roles the grant is refused; if that
  -- user has already granted them, SET ROLE still works and nothing is
  -- missing, and otherwise the message says what to run.
  BEGIN
    EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    BEGIN
      SET LOCAL ROLE anon; RESET ROLE;
      SET LOCAL ROLE authenticated; RESET ROLE;
      SET LOCAL ROLE service_role; RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'The roles anon, authenticated and service_role already exist in this server and were made by another user, so % cannot take them on. Run the gateway as that user, or have it run: GRANT anon, authenticated, service_role TO % WITH ADMIN OPTION', current_user, current_user;
    END;
  END;
END $r$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- Unqualified calls into extensions (uuid_generate_v4() and the like) resolve
-- the way they do on Supabase.
DO $sp$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'search_path not set on the database (%); the gateway sets it per request', SQLERRM;
END $sp$;

-- ── auth ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text DEFAULT NULL,
  phone_confirmed_at timestamptz,
  phone_change text DEFAULT '',
  phone_change_token varchar(255) DEFAULT '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  email_change_token_current varchar(255) DEFAULT '',
  email_change_confirm_status smallint DEFAULT 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) DEFAULT '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key ON auth.users (email) WHERE is_sso_user = false;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON auth.users (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users (instance_id);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON auth.users (lower(email));

CREATE TABLE IF NOT EXISTS auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data jsonb NOT NULL,
  provider text NOT NULL,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  UNIQUE (provider_id, provider)
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);
CREATE INDEX IF NOT EXISTS identities_email_idx ON auth.identities (email text_pattern_ops);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal text,
  not_after timestamptz,
  refreshed_at timestamp,
  user_agent text,
  ip inet,
  tag text
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_not_after_idx ON auth.sessions (not_after DESC);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  instance_id uuid,
  id bigserial PRIMARY KEY,
  token varchar(255) UNIQUE,
  user_id varchar(255),
  revoked boolean,
  created_at timestamptz,
  updated_at timestamptz,
  parent varchar(255),
  session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens (session_id, revoked);
CREATE INDEX IF NOT EXISTS refresh_tokens_parent_idx ON auth.refresh_tokens (parent);
-- GoTrue keeps refresh_tokens.user_id as text. The portal schema compares it
-- to a uuid in one place and to text in another; both read here.
DO $op$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
                 WHERE n.nspname = 'auth' AND o.oprname = '=' AND o.oprleft = 'varchar'::regtype AND o.oprright = 'uuid'::regtype) THEN
    CREATE FUNCTION auth._varchar_eq_uuid(varchar, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1::text = $2::text';
    CREATE OPERATOR auth.= (LEFTARG = varchar, RIGHTARG = uuid, FUNCTION = auth._varchar_eq_uuid, COMMUTATOR = OPERATOR(auth.=));
    CREATE FUNCTION auth._uuid_eq_varchar(uuid, varchar) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1::text = $2::text';
    CREATE OPERATOR auth.= (LEFTARG = uuid, RIGHTARG = varchar, FUNCTION = auth._uuid_eq_varchar);
  END IF;
END $op$;

CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friendly_name text,
  factor_type text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  secret text,
  phone text,
  last_challenged_at timestamptz,
  web_authn_credential jsonb,
  web_authn_aaguid uuid
);
CREATE INDEX IF NOT EXISTS mfa_factors_user_id_idx ON auth.mfa_factors (user_id);
CREATE TABLE IF NOT EXISTS auth.mfa_challenges (
  id uuid PRIMARY KEY,
  factor_id uuid NOT NULL REFERENCES auth.mfa_factors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  ip_address inet,
  otp_code text,
  web_authn_session_data jsonb
);
CREATE TABLE IF NOT EXISTS auth.mfa_amr_claims (
  session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  authentication_method text NOT NULL,
  id uuid PRIMARY KEY,
  UNIQUE (session_id, authentication_method)
);
CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
  instance_id uuid,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload json,
  created_at timestamptz DEFAULT now(),
  ip_address varchar(64) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_logs_instance_id_idx ON auth.audit_log_entries (instance_id);

-- What a request is, read from the settings the gateway puts on the
-- transaction, in the same words Supabase defines them.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email(), auth.jwt() TO anon, authenticated, service_role, supabase_auth_admin;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;

-- ── storage ────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner uuid,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version text,
  user_metadata jsonb,
  UNIQUE (bucket_id, name)
);
CREATE INDEX IF NOT EXISTS name_prefix_search ON storage.objects (name text_pattern_ops);
CREATE INDEX IF NOT EXISTS objects_bucket_name_idx ON storage.objects (bucket_id, name);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
-- The bytes. Only the gateway, as owner, touches these; the portal's
-- policies decide on storage.objects first.
CREATE TABLE IF NOT EXISTS storage.blobs (
  object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE CASCADE,
  part integer NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (object_id, part)
);
-- Resumable uploads in progress (the TUS route), and their parts.
CREATE TABLE IF NOT EXISTS storage.uploads (
  id text PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL,
  owner uuid,
  claims jsonb,
  size bigint NOT NULL,
  received bigint NOT NULL DEFAULT 0,
  metadata jsonb,
  upsert boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
CREATE TABLE IF NOT EXISTS storage.upload_parts (
  upload_id text NOT NULL REFERENCES storage.uploads(id) ON DELETE CASCADE,
  part integer NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (upload_id, part)
);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END $$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[array_length(_parts, 1)];
END $$;
CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[]; _filename text;
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  SELECT _parts[array_length(_parts, 1)] INTO _filename;
  RETURN reverse(split_part(reverse(_filename), '.', 1));
END $$;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text), storage.extension(text) TO anon, authenticated, service_role;

-- ── vault ──────────────────────────────────────────────────────────────────
-- Supabase Vault's surface, sealed with pgcrypto under the gateway's key,
-- which arrives on each connection as app.settings.vault_key and is never
-- written to the database. Owner only: the schema's own functions, which run
-- as the owner, are the only callers.
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  description text NOT NULL DEFAULT '',
  secret bytea NOT NULL,
  key_id uuid,
  nonce bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION vault._key() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.settings.vault_key', true), '')
$$;
CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_key text := vault._key();
BEGIN
  IF v_key IS NULL THEN RAISE EXCEPTION 'vault key is not set on this connection'; END IF;
  INSERT INTO vault.secrets (name, description, secret, key_id)
    VALUES (new_name, COALESCE(new_description, ''), extensions.pgp_sym_encrypt(COALESCE(new_secret, ''), v_key), new_key_id)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_key text := vault._key();
BEGIN
  IF v_key IS NULL THEN RAISE EXCEPTION 'vault key is not set on this connection'; END IF;
  UPDATE vault.secrets SET
    secret = CASE WHEN new_secret IS NULL THEN secret ELSE extensions.pgp_sym_encrypt(new_secret, v_key) END,
    name = COALESCE(new_name, name),
    description = COALESCE(new_description, description),
    key_id = COALESCE(new_key_id, key_id),
    updated_at = now()
  WHERE id = secret_id;
END $$;
CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT id, name, description, secret, key_id, nonce, created_at, updated_at,
    CASE WHEN vault._key() IS NULL THEN NULL ELSE extensions.pgp_sym_decrypt(secret, vault._key()) END AS decrypted_secret
  FROM vault.secrets;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
REVOKE ALL ON vault.secrets FROM PUBLIC;
REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC;
REVOKE ALL ON FUNCTION vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid), vault._key() FROM PUBLIC;
GRANT USAGE ON SCHEMA vault TO service_role;

-- ── pental: the gateway's own state, and live changes ──────────────────────
CREATE SCHEMA IF NOT EXISTS pental;
REVOKE ALL ON SCHEMA pental FROM PUBLIC;
CREATE TABLE IF NOT EXISTS pental.meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A row changed: its table and its key, no more, over NOTIFY. The gateway
-- reads the row again as each subscriber, so the row policies decide who
-- sees it, and the 8 kB NOTIFY limit is never met by a long finding.
CREATE OR REPLACE FUNCTION pental.rt_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_keys text[] := TG_ARGV;
  v_new jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_pk jsonb := '{}'::jsonb;
  v_pk_old jsonb := '{}'::jsonb;
  v_k text;
BEGIN
  FOREACH v_k IN ARRAY v_keys LOOP
    IF v_new IS NOT NULL THEN v_pk := v_pk || jsonb_build_object(v_k, v_new -> v_k); END IF;
    IF v_old IS NOT NULL THEN v_pk_old := v_pk_old || jsonb_build_object(v_k, v_old -> v_k); END IF;
  END LOOP;
  PERFORM pg_notify('pental_rt', json_build_object(
    's', TG_TABLE_SCHEMA, 't', TG_TABLE_NAME, 'op', TG_OP,
    'k', CASE WHEN TG_OP = 'DELETE' THEN v_pk_old ELSE v_pk END,
    'ko', CASE WHEN TG_OP = 'UPDATE' THEN v_pk_old ELSE NULL END,
    'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text);
  RETURN NULL;
END $$;
-- Put the trigger on every table in the realtime publication that has a
-- primary key, and take it off tables that left it. Returns how many carry it.
CREATE OR REPLACE FUNCTION pental.rt_attach() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; v_keys text; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT c.oid, n.nspname, c.relname,
      (SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY k.ord)
         FROM pg_index i
         JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
      EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'pental_rt' AND NOT t.tgisinternal) AS has_trigger,
      EXISTS (SELECT 1 FROM pg_publication_tables pt WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = n.nspname AND pt.tablename = c.relname) AS published
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
  LOOP
    IF r.published AND r.pk IS NOT NULL THEN
      IF NOT r.has_trigger THEN
        EXECUTE format('CREATE TRIGGER pental_rt AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION pental.rt_notify(%s)', r.nspname, r.relname, r.pk);
      END IF;
      v_n := v_n + 1;
    ELSIF r.has_trigger THEN
      EXECUTE format('DROP TRIGGER pental_rt ON %I.%I', r.nspname, r.relname);
    END IF;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION pental.rt_notify(), pental.rt_attach() FROM PUBLIC;

-- A session that ends (signed out, revoked from another device, its account
-- removed) is announced, so the gateway stops honouring it at once, on live
-- channels too, rather than when its cached answer runs out.
CREATE OR REPLACE FUNCTION pental.session_end_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('pental_session_end', OLD.id::text);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION pental.session_end_notify() FROM PUBLIC;
CREATE OR REPLACE TRIGGER pental_session_end AFTER DELETE ON auth.sessions FOR EACH ROW EXECUTE FUNCTION pental.session_end_notify();
