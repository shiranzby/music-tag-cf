/**
 * worker_base.js — Shared utilities for music-tag-cf Worker
 *
 * Provides CORS handling, response formatting, and error handling
 * common to all API routes.
 */

/**
 * Generate CORS headers for cross-origin requests from any Pages domain.
 */
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Send a JSON response with CORS headers.
 */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...corsHeaders(),
    },
  });
}

/**
 * Send a structured error JSON response.
 */
export function errorResponse(message, status = 400, detail = null) {
  const body = { error: { message, code: status } };
  if (detail) body.error.detail = detail;
  return jsonResponse(body, status);
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Returns null if not an OPTIONS request, Response if it is.
 */
export function handlePreflight(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return null;
}

/**
 * Build an absolute URL from a request to forward to upstream.
 */
export function buildProxyUrl(baseUrl, searchParams) {
  const url = new URL(baseUrl);
  searchParams.forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

/**
 * Fetch with timeout and retry for upstream API calls.
 */
export async function fetchWithRetry(url, options = {}, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response;
    } catch (err) {
      lastError = err;
      if (i < retries) {
        // Simple backoff
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
  throw lastError;
}
