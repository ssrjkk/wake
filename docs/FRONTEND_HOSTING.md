# Frontend Hosting off Cloudflare Pages

The site runs today as a static bundle on Pages (https://wake-7k6.pages.dev, deploy
described in `README.md` → Deployment). Nothing in the frontend needs Pages: it is a
directory of files produced by `npm run build`, and any static server can hand it out.
What Pages does for free has to be configured by hand elsewhere, and that is the whole
content of this document.

The backend on a self-hosted machine is a different question and lives in
[`RAILWAY_DEPLOY.md`](RAILWAY_DEPLOY.md) — the image, the variables, the signing service.

## 1. What the build produces

```bash
npm ci
npm run build     # tsc -b && vite build, output: dist/
```

`dist/` is self-contained: hashed chunks under `dist/assets/`, `index.html`, the icons,
and copies of `public/_headers` and `public/_redirects`. Those two files are inert here —
they are instructions for Cloudflare's edge, and nginx does not read them. Delete them or
ignore them; the server config below replaces them.

`VITE_*` values are compiled in on the machine that builds, from the root `.env` — there
is no runtime configuration of a served bundle. Before building, three of them describe
the deployment, not the code:

| Variable | On Pages | On your own host |
| --- | --- | --- |
| `VITE_SITE_URL` | default `https://wake-7k6.pages.dev` | your address, with scheme: `https://wake.example.com` |
| `VITE_BACKEND_URL` | the Railway URL | `https://api.example.com` (or your own backend) |
| `VITE_LIGHTER_NETWORK` | `mainnet` | unchanged unless the backend was built for testnet |

`VITE_SITE_URL` is what `canonical`, `og:url`, `og:image`, `twitter:image` and the
`preconnect` to Lighter are generated from (the substitution lives in `vite.config.ts`,
the values are checked by `npm run check:headers`). Left at the Pages default on your own
domain, the page still works and tells every crawler — and every messenger building a
link preview — that its canonical location is `wake-7k6.pages.dev`. A value without a
scheme aborts the build rather than emitting a relative `canonical`.

`VITE_BACKEND_URL` and the backend's `WAKE_CORS_ORIGINS` must name each other: the
allowlist is the frontend origin, so `https://wake.example.com` has to be in the backend
configuration before the first request from the new host is anything but a CORS error.

One artifact does not follow the variable: `public/og.png` is a picture, and the address
printed in its bottom-right corner is the Pages one — it is a literal in the card markup,
`scripts/brand-assets.mjs:61`, and the script redraws the file at 1200×630. On your own
domain, change that line and re-run the script. Do not "fix" the mismatch by pointing
`og:image` back at the Pages URL: then the card stops loading from the site it advertises.

A production build refuses a `VITE_BACKEND_URL` that points at the machine running the
build (`localhost`, `127.*`, `::1`) — see `src/lib/loopback.ts`. For a host-local test,
run `npm run dev` instead of shipping a bundle that talks to the visitor's own laptop.

## 2. Headers and the SPA fallback

The rules below are the content of `public/_headers` plus the one line `_redirects`
carries, written for a server that has to be told. Two things are load-bearing and easy
to get backwards:

- Files under `/assets/` have the hash of their contents in their name. They are cacheable
  forever, and caching them for a short time buys nothing: a redeploy changes the names,
  so there is no stale content to invalidate.
- `index.html` names those files. Caching it is precisely how a redeployed site starts
  asking for chunks that no longer exist — a browser holding the old `index.html` requests
  the old chunk names and gets the fallback page instead of a module. `src/lib/preload.ts`
  reloads once when that happens; a `max-age=0` `index.html` is what stops it happening.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name wake.example.com;
    root /var/www/wake;                       # contents of dist/
    index index.html;

    # HSTS belongs only on the HTTPS server; sending it over plaintext is ignored.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()" always;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()" always;
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()" always;
        try_files $uri $uri/ /index.html;      # _redirects: /* /index.html 200
    }
}
```

In nginx, `add_header` inside a `location` replaces the inherited set rather than adding to
it — hence the repeated four lines. Caddy needs no repetition:

```caddy
wake.example.com {
    root * /var/www/wake
    encode gzip zstd
    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"
    handle {
        try_files {path} /index.html
        file_server
    }
}
```

The CSP line is deliberately not copied above. It is currently
`Content-Security-Policy-Report-Only` in `public/_headers`, with the reason written in that
file: the Telegram login widget executes a string as code, so an enforced version of the
policy that is otherwise correct would break the login button. Moving the site does not
change that. Whatever serves the bundle should ship the same Report-Only line — as a header,
not as a `<meta>` tag, because `frame-src` and the navigation policies are ignored in meta.

## 3. After the first response

`npm run check:headers` walks the built bundle in a browser under the policy in
`public/_headers`, and it is the check to run before shipping: it is what found that
`oauth.telegram.org` — the frame the login widget opens, assembled at runtime and absent
from the bundle text — had to be allowed explicitly.

It cannot check your server. It reads `public/_headers`; nginx and Caddy have their own
copy of the same rules in the config above, and those two drift the moment someone edits
one file. So after deploying, read the headers off the live address:

```bash
curl -sSI https://wake.example.com/ | grep -iE 'cache-control|content-security|x-content-type|referrer|permissions'
name=$(curl -s https://wake.example.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sSI "https://wake.example.com/$name" | grep -i cache-control   # must be the immutable line
curl -s -o /dev/null -w '%{http_code}\n' https://wake.example.com/some/deep/route   # 200, not 404
curl -s https://wake.example.com/ | grep -o 'rel="canonical" href="[^"]*"'          # your own address
```

The last two commands are the two failures that ship silently: a deep route answering 404
means the SPA fallback is missing, and a `canonical` naming another host means the build
ran without `VITE_SITE_URL`. A panel that reports the backend unreachable while `curl` from
the server succeeds is usually `WAKE_CORS_ORIGINS`, not the frontend.
