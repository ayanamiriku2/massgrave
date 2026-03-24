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

// ─── decompress helper ───────────────────────────────────────────────────────
function decompressBuffer(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip") {
      zlib.gunzip(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "deflate") {
      zlib.inflate(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "br") {
      zlib.brotliDecompress(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else {
      resolve(buffer);
    }
  });
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

      // Set correct content-length for rewritten body
      const outBuffer = Buffer.from(rewritten, "utf-8");
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
