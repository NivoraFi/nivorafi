import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PATHS = new Set([
  "health",
  "stats",
  "analytics/sparkline",
  "events",
  "charts",
  "timeseries",
  "positions",
]);

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const resolvedParams = await context.params;
  const path = resolvedParams?.path || [];
  const joinedPath = path.join("/").replace(/^\/+|\/+$/g, "");

  if (!ALLOWED_PATHS.has(joinedPath)) {
    return NextResponse.json(
      { success: false, error: "Not Found" },
      { status: 404 }
    );
  }

  const upstreamBase = (
    process.env.INDEXER_INTERNAL_URL || "http://127.0.0.1:3001"
  ).replace(/\/+$/, "");
  const secret = (process.env.INDEXER_API_SECRET || "").trim();

  const search = req.nextUrl?.search || "";
  const targetUrl = `${upstreamBase}/${joinedPath}${search}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (secret) {
      headers["x-indexer-secret"] = secret;
    }

    const upstreamRes = await fetch(targetUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });

    const bodyText = await upstreamRes.text();
    const cacheHeader =
      joinedPath === "positions"
        ? "private, no-store"
        : "public, s-maxage=3, stale-while-revalidate=10";

    return new NextResponse(bodyText, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": cacheHeader,
      },
    });
  } catch {
    // Never leak internal upstream URL or network topology in error payload
    return NextResponse.json(
      { success: false, status: "offline", error: "Indexer upstream unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    clearTimeout(timer);
  }
}
