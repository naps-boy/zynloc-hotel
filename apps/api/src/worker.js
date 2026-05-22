export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "zynloc-worker-api" });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: "Cloudflare Worker API gateway is configured. Deploy the Node API to Railway or refactor Express routes to Worker handlers for full edge execution.",
          path: url.pathname,
          requiredSecrets: ["DATABASE_URL", "JWT_SECRET", "STRIPE_SECRET_KEY"]
        },
        { status: 501 }
      );
    }

    return new Response("Zynloc Hotel API", { status: 200 });
  }
};
