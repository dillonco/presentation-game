# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead:
**[Report a vulnerability](https://github.com/dillonco/presentation-game/security/advisories/new)**.

Say what you found, how to reproduce it, and what someone could do with it. You'll get a reply as soon
as possible, and credit in the fix if you'd like it.

Fixes go into the latest version only, so please check that the problem is still there in `main`.

## Running your own server safely

- Set `SESSION_SECRET` to a long random value. `npm run setup` makes one.
- Use a strong `ADMIN_PASSWORD`. Changing it signs every presenter out.
- Serve the app over HTTPS. Sign-in cookies are only marked Secure, and HSTS is only sent, when the
  request arrived over HTTPS (`X-Forwarded-Proto: https` behind a proxy). Set `FORCE_HTTPS=true`
  unless your host already redirects plain HTTP, so nobody signs in where the network can read it.
- Behind a proxy or a hosting platform, set `TRUST_PROXY` to the number of proxies in front of the
  server, usually `1`. Each visitor then gets their own limits. Never set it higher than the real
  count, or visitors can choose their own address. Check that the proxy passes on real addresses
  first: `yourAddress` in `/api/admin/stats` should be yours. If every visitor shows up as one
  internal address, leave `TRUST_PROXY` out, or one visitor's limit becomes everyone's.
- With `HOSTED=true`, run a single instance. Rate limits and space sessions are kept in memory.
