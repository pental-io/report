-- reporter-overlay: 1
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
