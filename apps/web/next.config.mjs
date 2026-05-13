/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@claude-hub/schema"],
  // Daemon (na uživatelově počítači) potřebuje forwardovat OTLP telemetrii
  // na centrální Hub API. Z internetu se ale dostane jen na web (přes nginx
  // na hub.animato-lab.cz), ne na izolované API. Tento rewrite zpřístupní
  // API endpointy pod `/api/...` na stejné doméně a Next.js požadavky
  // přepošle interní Docker network adresou.
  async rewrites() {
    const apiInternalUrl = process.env.CLAUDE_HUB_API_URL ?? "http://api:8787";
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/:path*`
      }
    ];
  }
};

export default nextConfig;
