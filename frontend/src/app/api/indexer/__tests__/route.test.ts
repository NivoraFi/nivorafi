// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { GET } from "../[...path]/route";

describe("BFF Security Route (/api/indexer/[...path])", () => {
  describe("1. Access Control & Whitelist Enforcement", () => {
    it("allows all explicitly whitelisted paths", async () => {
      const allowedPaths = [
        ["health"],
        ["stats"],
        ["analytics", "sparkline"],
        ["events"],
        ["charts"],
        ["timeseries"],
        ["positions"],
      ];

      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        for (const path of allowedPaths) {
          const req = new NextRequest(`http://localhost:3000/api/indexer/${path.join("/")}`);
          const res = await GET(req, { params: Promise.resolve({ path }) });
          expect(res.status).toBe(200);
        }
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("rejects unauthorized and malicious paths with 404", async () => {
      const forbiddenPaths = [
        ["admin"],
        ["admin", "config"],
        ["internal", "keys"],
        ["debug"],
        ["..", "etc", "passwd"],
        ["health", "..", "admin"],
        ["eval"],
        ["exec"],
        [],
      ];

      for (const path of forbiddenPaths) {
        const req = new NextRequest(`http://localhost:3000/api/indexer/${path.join("/")}`);
        const res = await GET(req, { params: Promise.resolve({ path }) });
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error).toBe("Not Found");
      }
    });
  });

  describe("2. Security Headers & Secret Injection", () => {
    it("injects x-indexer-secret header when configured", async () => {
      const origInternalUrl = process.env.INDEXER_INTERNAL_URL;
      const origSecret = process.env.INDEXER_API_SECRET;
      process.env.INDEXER_INTERNAL_URL = "http://internal-indexer.local:3001";
      process.env.INDEXER_API_SECRET = "super-secret-key-xyz";

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedHeaders = (init?.headers as Record<string, string>) || {};
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/stats?market=usdc-90d");
        const res = await GET(req, { params: Promise.resolve({ path: ["stats"] }) });

        expect(res.status).toBe(200);
        expect(capturedUrl).toBe("http://internal-indexer.local:3001/stats?market=usdc-90d");
        expect(capturedHeaders["x-indexer-secret"]).toBe("super-secret-key-xyz");
        expect(capturedHeaders["Accept"]).toBe("application/json");
      } finally {
        globalThis.fetch = origFetch;
        process.env.INDEXER_INTERNAL_URL = origInternalUrl;
        process.env.INDEXER_API_SECRET = origSecret;
      }
    });

    it("omits x-indexer-secret header when secret is not configured", async () => {
      const origSecret = process.env.INDEXER_API_SECRET;
      delete process.env.INDEXER_API_SECRET;

      let capturedHeaders: Record<string, string> = {};
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
          capturedHeaders = (init?.headers as Record<string, string>) || {};
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/health");
        await GET(req, { params: Promise.resolve({ path: ["health"] }) });
        expect(capturedHeaders["x-indexer-secret"]).toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
        process.env.INDEXER_API_SECRET = origSecret;
      }
    });
  });

  describe("3. Cache-Control Security Policy", () => {
    it("sets private, no-store for user sensitive positions endpoint", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/positions?account=GBXYZ");
        const res = await GET(req, { params: Promise.resolve({ path: ["positions"] }) });
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("sets public cache with stale-while-revalidate for public aggregated endpoints", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ impliedApy: 8.45 }), { status: 200 });
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/stats");
        const res = await GET(req, { params: Promise.resolve({ path: ["stats"] }) });
        expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3, stale-while-revalidate=10");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("4. Error Sanitization & Upstream Isolation", () => {
    it("returns 502 with no internal network topology leakage on connection failure", async () => {
      const origInternalUrl = process.env.INDEXER_INTERNAL_URL;
      process.env.INDEXER_INTERNAL_URL = "http://super-sensitive-indexer-vpc.internal:8080";

      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("connect ECONNREFUSED super-sensitive-indexer-vpc.internal:8080");
        }) as typeof fetch;

        const req = new NextRequest("http://localhost:3000/api/indexer/health");
        const res = await GET(req, { params: Promise.resolve({ path: ["health"] }) });

        expect(res.status).toBe(502);
        expect(res.headers.get("Cache-Control")).toBe("no-store");

        const text = await res.text();
        expect(text).not.toContain("super-sensitive-indexer-vpc");
        expect(text).not.toContain("8080");
        expect(text).not.toContain("ECONNREFUSED");

        const parsed = JSON.parse(text);
        expect(parsed).toEqual({
          success: false,
          status: "offline",
          error: "Indexer upstream unavailable",
        });
      } finally {
        globalThis.fetch = origFetch;
        process.env.INDEXER_INTERNAL_URL = origInternalUrl;
      }
    });
  });
});
