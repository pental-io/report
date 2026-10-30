# supabase-js 2.39.3, served by the portal itself (1804)

`supabase.js` and `26.supabase.js` are `dist/umd/` of the npm package
`@supabase/supabase-js@2.39.3`, byte for byte (SHA256SUMS; MIT, LICENSE
beside them). The portal used to load this library from cdn.jsdelivr.net;
it is now copied into `dist/assets/` by build.js and loaded from the
portal's own origin, so the client library, like the portal, comes from
Pental and from nowhere else, at a version pinned here.

The library is the portal's client for the four APIs its database answers
(REST, sign-in, files, live updates), whichever of the three homes the
database is in: Supabase Cloud, a self-hosted Supabase stack, or the firm's
own PostgreSQL behind the Pental gateway, which speaks the same APIs. It
talks only to EFFECTIVE_SUPABASE_URL with the publishable key.

`26.supabase.js` is the bundle's one lazy chunk (the `ws` shim, which only a
Node runtime would ask for); it is served at its own name beside the bundle
so the loader's path resolves if it is ever requested.

To upgrade: `npm pack @supabase/supabase-js@<version>`, copy the two files,
refresh SHA256SUMS, and change the version in build.js.
