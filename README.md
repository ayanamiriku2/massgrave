# massgrave-mirror

Full mirror proxy for `massgrave.dev` → `massgrave.run` with SEO-safe URL rewriting.

## Features

- Full reverse proxy mirroring all pages, assets, sitemaps, and API routes
- **SEO-safe**: rewrites `<link rel="canonical">`, `og:url`, `twitter:url`, JSON-LD, `<loc>` in sitemaps, hreflang alternate links
- Rewrites **all** internal links, `href`, `src`, `action` attributes from origin to mirror domain
- Rewrites `Location` headers on redirects, `Set-Cookie` domains, `Link` headers
- `robots.txt` rewriting with sitemap reference to mirror domain
- Handles gzip/brotli/deflate decompression for content rewriting
- Binary assets (images, fonts, etc.) passed through untouched
- Ready to deploy on **Railway**, **Render**, or **any VPS / Docker host**

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ORIGIN_HOST` | `massgrave.dev` | The source website to mirror |
| `MIRROR_HOST` | `massgrave.run` | Your mirror domain |
| `PORT` | `3000` | Server listen port |

## Deploy

### Railway

1. Push this repo to GitHub
2. Connect the repo in [Railway](https://railway.app)
3. Railway auto-detects the `Dockerfile` or `railway.toml`
4. Set custom domain to `massgrave.run`

### Render

1. Push this repo to GitHub
2. Create a new **Web Service** in [Render](https://render.com) → connect repo
3. Render auto-detects via `render.yaml`
4. Set custom domain to `massgrave.run`

### VPS / Docker

```bash
docker build -t massgrave-mirror .
docker run -d -p 80:3000 \
  -e ORIGIN_HOST=massgrave.dev \
  -e MIRROR_HOST=massgrave.run \
  massgrave-mirror
```

Or without Docker:

```bash
npm ci --omit=dev
PORT=3000 node server.js
```

### Nginx reverse proxy (optional, for SSL on VPS)

```nginx
server {
    listen 443 ssl http2;
    server_name massgrave.run;

    ssl_certificate     /etc/letsencrypt/live/massgrave.run/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/massgrave.run/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## SEO Notes

This mirror solves the **duplicate canonical content** issue by:

1. Rewriting all `<link rel="canonical">` tags to point to `massgrave.run`
2. Rewriting `og:url` and `twitter:url` meta tags
3. Rewriting JSON-LD structured data URLs
4. Rewriting XML sitemap `<loc>` entries
5. Rewriting hreflang alternate link tags
6. Ensuring `robots.txt` references the mirror's sitemap
7. Rewriting all internal `href`/`src` attributes

Google Search Console will see `massgrave.run` as the canonical source, eliminating duplicate content flags.