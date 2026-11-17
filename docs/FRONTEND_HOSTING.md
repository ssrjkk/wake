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

Two more literals ship for the same reason: `public/robots.txt` names the sitemap with a
host, and `public/sitemap.xml` carries one `<loc>`. Vite substitutes `VITE_SITE_URL` into
`index.html` and leaves everything else in `public/` byte for byte, so on your own domain
both lines are edited by hand — and `npm run check:headers` reads both files out of `dist`
and fails the check if either host disagrees with the `canonical` of the page it just
built. That check exists because a stale sitemap is silent: the wrong domain simply gets
indexed.

A production build refuses a `VITE_BACKEND_URL` that points at the machine running the
build (`localhost`, `127.*`, `::1`) — see `src/lib/loopback.ts`. For a host-local test,
run `npm run dev` instead of shipping a bundle that talks to the visitor's own laptop.

The other loopback address is meant to survive onto an HTTPS host: `VITE_SIGNING_SERVICE_URL`
stays `http://localhost:8787`, because the solo terminal signs orders through a service on
the visitor's own machine. Browsers do not treat that as mixed content — MDN's mixed-content
page counts loopback among secure origins: "Local resources are considered to be from secure
origins, just like HTTPS origins. This includes `file:` URLs, and content accessed from
loopback addresses such as `http://127.0.0.1/` or `http://localhost/`." Both loopback origins
are therefore listed in `connect-src`. On an https page this is the only http origin the
policy names: mixed content applies to a secure context fetching an insecure one, so every
other `http://` address would be blocked before CSP was consulted, and an http page fetching
http is not mixed content at all.

## 2. Headers and the SPA fallback

The rules below are what `public/_headers` and `public/_redirects` carry, written for a
server that has to be told. Three things are load-bearing and easy
to get backwards:

- Files under `/assets/` have the hash of their contents in their name. They are cacheable
  forever, and caching them for a short time buys nothing: a redeploy changes the names,
  so there is no stale content to invalidate.
- `index.html` names those files. Caching it is precisely how a redeployed site starts
  asking for chunks that no longer exist — a browser holding the old `index.html` requests
  the old chunk names and gets the fallback page instead of a module. `src/lib/preload.ts`
  reloads once when that happens; a `max-age=0` `index.html` is what stops it happening.
- A file the config does not name is revalidated forever. On Pages this is a measurement,
  not a reading of the docs: the deploy that was live until now shipped no `_headers` at
  all, and `/og.png`, `/robots.txt` and `/sitemap.xml` answered `public, max-age=0,
  must-revalidate` — the last two also with `text/html`, because what answered them was
  the SPA fallback, not a file. nginx reaches the same place by its own rule: a path that
  matches no regex `location` falls through to `location /` and takes its `max-age=0`.
  These three kinds of file change by hand and keep their names, so they are exactly the
  ones a year of `immutable` must not be applied to — a day and an hour are the numbers.

nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name wake.example.com;
    root /var/www/wake;                       # contents of dist/
    index index.html;

    # No add_header here on purpose — see the inheritance rule below.

    location /assets/ {
        include /etc/nginx/snippets/wake-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    # Regex locations are consulted before the prefix `location /` below, so a
    # hand-edited file that is not named here inherits max-age=0 silently.
    location ~* ^/(og\.png|favicon\.svg|apple-touch-icon\.png)$ {
        include /etc/nginx/snippets/wake-headers.conf;
        add_header Cache-Control "public, max-age=86400" always;
        try_files $uri =404;
    }

    location ~* ^/(robots\.txt|sitemap\.xml)$ {
        include /etc/nginx/snippets/wake-headers.conf;
        add_header Cache-Control "public, max-age=3600" always;
        try_files $uri =404;
    }

    location = /favicon.ico {
        # _redirects: /favicon.ico /favicon.svg 301. The page declares an SVG
        # icon, yet browsers still ask for the .ico; without this rule they get
        # index.html with text/html, same as on Pages before the rule existed.
        return 301 /favicon.svg;
    }

    location / {
        include /etc/nginx/snippets/wake-headers.conf;
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
        try_files $uri $uri/ /index.html;      # _redirects: /* /index.html 200
    }
}
```

```nginx
# /etc/nginx/snippets/wake-headers.conf — HSTS belongs only on the HTTPS server;
# sending it over plaintext is ignored.
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()" always;
```

The snippet is not cosmetics. The nginx docs state the rule: `add_header` directives "are
inherited from the previous configuration level if and only if there are no `add_header`
directives defined on the current level" (ngx_http_headers_module). So the moment a
`location` sets its own `Cache-Control`, every header written in the `server` block stops
reaching that response — put the four shared headers above the two locations and the site
serves no HSTS at all, since each request lands in a location. Same-named directives inside
one level do stack, which is why the snippet plus the per-location `Cache-Control` both
arrive. From nginx 1.29.3 there is `add_header_inherit merge;`, which appends the parent
values instead of dropping them; before that version, include or repeat.

Caddy needs no repetition because its own ordering does the work: the hard-coded directive
order puts `header` ahead of `handle` and `file_server` (Caddyfile → Directives → Directive
order), so one site-level `header` wraps every response the file server produces:

```caddy
wake.example.com {
    root * /var/www/wake
    encode gzip zstd
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()"
    }
    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"
    @brand path /og.png /favicon.svg /apple-touch-icon.png
    header @brand Cache-Control "public, max-age=86400"
    @robots path /robots.txt /sitemap.xml
    header @robots Cache-Control "public, max-age=3600"
    redir /favicon.ico /favicon.svg 301        # _redirects: same rule
    handle {
        try_files {path} /index.html
        file_server
    }
}
```

The two blocks differ on one point and it is deliberate: nginx answers `=404` for a named
file that is missing, while Caddy and Pages let the request fall through to the SPA
fallback and answer `200` with HTML — the answer measured above for `/robots.txt` before
the file existed. A cache rule for a path that is not in the build is a mistake nobody
sees, so `npm run check:headers` now compares every non-wildcard `Cache-Control` rule
against `dist` and fails on an orphan: on the server path `=404` can then only be reached
by a URL the client mistyped.

The CSP line is deliberately not copied above. It is currently
`Content-Security-Policy-Report-Only` in `public/_headers`, with the reason written in that
file: the Telegram login widget executes a string as code, so an enforced version of the
policy that is otherwise correct would break the login button. Moving the site does not
change that. Whatever serves the bundle should ship the same Report-Only line — as a header,
not as a `<meta>` tag. CSP Level 3 §3.3 is explicit about what meta cannot carry: the
`Content-Security-Policy-Report-Only` header — which is exactly what our line is — is not
supported there, and neither are the `report-uri`, `frame-ancestors` and `sandbox`
directives. A meta policy also starts only where it appears in the document, so anything
prefetched through a `Link` header or an earlier `<link>`/`<script>` is outside it.

## 3. After the first response

`npm run check:headers` walks the built bundle in a browser under the policy in
`public/_headers`, and it is the check to run before shipping: it is what found that
`oauth.telegram.org` — the frame the login widget opens, assembled at runtime and absent
from the bundle text — had to be allowed explicitly. It replays `public/_redirects` too,
so the file is served the way Pages will serve it, and it opens the login modal, which is
the only step where the Telegram widget mounts at all: without that click the enforced
`script-src` violation is invisible and a green run means the path was never walked.

It cannot check your server. It reads `public/_headers`; nginx and Caddy have their own
copy of the same rules in the config above, and those two drift the moment someone edits
one file. So after deploying, read the headers off the live address:

```bash
curl -sSI https://wake.example.com/ | grep -iE 'cache-control|content-security|x-content-type|referrer|permissions'
name=$(curl -s https://wake.example.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sSI "https://wake.example.com/$name" | grep -i cache-control   # must be the immutable line
curl -s -o /dev/null -w '%{http_code}\n' https://wake.example.com/some/deep/route   # 200, not 404
curl -s https://wake.example.com/ | grep -o 'rel="canonical" href="[^"]*"'          # your own address
curl -sSI https://wake.example.com/robots.txt | grep -i '^content-type'   # text/plain, never text/html
curl -s https://wake.example.com/sitemap.xml | grep -o '<loc>[^<]*'       # your address, not the Pages one
curl -sSI https://wake.example.com/favicon.ico | grep -iE '^(location|HTTP/)'   # 301 to /favicon.svg, not 200 text/html
```

The last two commands are the two failures that ship silently: a deep route answering 404
means the SPA fallback is missing, and a `canonical` naming another host means the build
ran without `VITE_SITE_URL`. A panel that reports the backend unreachable while `curl` from
the server succeeds is usually `WAKE_CORS_ORIGINS`, not the frontend. For the robot files
the status code proves nothing — the fallback answers `200` — so the check is the
`content-type`: `text/html` on `/robots.txt` means the file did not ship. The favicon line
is the same failure seen from the other side: `200` with `text/html` there means the
redirect rule is missing and the browser is being handed the page as an icon.
