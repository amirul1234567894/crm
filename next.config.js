/** @type {import('next').NextConfig} */

/**
 * Security headers.
 *
 * Purono config e ekta o chilo na — clickjacking, MIME sniffing, referrer leak
 * sob khola chilo. Eta production e jawar age must.
 */
const securityHeaders = [
  // Iframe e load kora jabe na — clickjacking bondho
  { key: "X-Frame-Options", value: "DENY" },

  // Browser ke MIME type guess korte dibe na
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Onno site e jawar somoy puro URL (org slug soho) pathabe na
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Camera/mic/location — CRM er kono dorkar nei
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },

  // HTTPS badhyotamulok. 2 bochor. Preload list e dite chaile
  // hstspreload.org e submit korte hobe.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },

  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",

      // Next.js hydration e inline script lage. Nonce setup korle
      // 'unsafe-inline' ar 'unsafe-eval' sorate parbi — kintu setup ta jhamela.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",

      // Google Fonts globals.css e import kora ache
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",

      // Supabase Storage + Meta CDN (customer profile pic, media)
      "img-src 'self' data: blob: https://*.supabase.co https://*.fbcdn.net https://*.cdninstagram.com",

      // Supabase REST + Realtime websocket + Meta Graph API
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://graph.facebook.com",

      // X-Frame-Options er modern version
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

module.exports = {
  reactStrictMode: true,

  // "X-Powered-By: Next.js" header sorao — version disclosure
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Webhook e CSP/frame header er kono mane nei, kintu
        // search engine ke door e rakha dorkar
        source: "/api/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};
