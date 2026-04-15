/**
 * Subscription Worker
 *
 * A reusable Cloudflare Worker that:
 * 1. Receives Stripe webhook events (checkout completed, subscription updated/deleted)
 * 2. Stores subscription status in Cloudflare KV keyed by customer email
 * 3. Serves subscription status to authenticated frontends
 *
 * Environment bindings:
 *   SUBSCRIPTIONS    - KV namespace for storing subscription data
 *   STRIPE_WEBHOOK_SECRET - Stripe webhook signing secret (set via wrangler secret)
 *   ALLOWED_ORIGINS  - Comma-separated allowed CORS origins
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // POST /webhook — Stripe webhook receiver
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env, corsHeaders);
      }

      // GET /status?email=user@example.com — check subscription status
      if (url.pathname === "/status" && request.method === "GET") {
        return await handleStatusCheck(request, env, corsHeaders);
      }

      // GET /health — simple health check
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ ok: true, timestamp: Date.now() }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  },
};

/**
 * Handle incoming Stripe webhook events.
 * Verifies the webhook signature, then processes relevant events.
 */
async function handleWebhook(request, env, corsHeaders) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response(
      JSON.stringify({ error: "Missing signature or webhook secret" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Verify Stripe webhook signature
  const isValid = await verifyStripeSignature(
    body,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!isValid) {
    return new Response(
      JSON.stringify({ error: "Invalid webhook signature" }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const event = JSON.parse(body);
  const eventType = event.type;

  // Process relevant subscription events
  if (
    eventType === "checkout.session.completed" ||
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated" ||
    eventType === "customer.subscription.deleted" ||
    eventType === "invoice.payment_succeeded" ||
    eventType === "invoice.payment_failed"
  ) {
    await processSubscriptionEvent(event, env);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Process a Stripe subscription-related event and update KV.
 */
async function processSubscriptionEvent(event, env) {
  const eventType = event.type;
  const data = event.data.object;

  let email = null;
  let status = null;
  let subscriptionId = null;
  let customerId = null;
  let productId = null;
  let currentPeriodEnd = null;

  if (eventType === "checkout.session.completed") {
    email = data.customer_details?.email || data.customer_email;
    customerId = data.customer;
    subscriptionId = data.subscription;
    status = data.payment_status === "paid" ? "active" : "pending";
  } else if (
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated"
  ) {
    customerId = data.customer;
    subscriptionId = data.id;
    status = data.status; // active, past_due, canceled, unpaid, etc.
    currentPeriodEnd = data.current_period_end;

    // Get the product ID from the first subscription item
    if (data.items?.data?.[0]?.price?.product) {
      productId = data.items.data[0].price.product;
    }
  } else if (eventType === "customer.subscription.deleted") {
    customerId = data.customer;
    subscriptionId = data.id;
    status = "canceled";
  } else if (eventType === "invoice.payment_succeeded") {
    customerId = data.customer;
    subscriptionId = data.subscription;
    email = data.customer_email;
    status = "active";
  } else if (eventType === "invoice.payment_failed") {
    customerId = data.customer;
    subscriptionId = data.subscription;
    email = data.customer_email;
    status = "past_due";
  }

  // If we don't have an email yet, try to look it up from existing KV data
  // by customer ID (if we stored it from a previous event)
  if (!email && customerId) {
    const customerMapping = await env.SUBSCRIPTIONS.get(
      `customer:${customerId}`
    );
    if (customerMapping) {
      email = customerMapping;
    }
  }

  if (!email) {
    console.warn(
      `No email found for event ${eventType}, customer ${customerId}`
    );
    return;
  }

  // Normalize email to lowercase
  email = email.toLowerCase().trim();

  // Store the customer → email mapping for future lookups
  if (customerId) {
    await env.SUBSCRIPTIONS.put(`customer:${customerId}`, email);
  }

  // Build subscription record
  const record = {
    email,
    status,
    subscriptionId: subscriptionId || null,
    customerId: customerId || null,
    productId: productId || null,
    currentPeriodEnd: currentPeriodEnd || null,
    updatedAt: Date.now(),
    lastEvent: eventType,
  };

  // Store by email (primary lookup key for frontend)
  await env.SUBSCRIPTIONS.put(`sub:${email}`, JSON.stringify(record));

  console.log(
    `Subscription updated: ${email} → ${status} (event: ${eventType})`
  );
}

/**
 * Handle subscription status check requests from the frontend.
 * Expects ?email=user@example.com query parameter.
 */
async function handleStatusCheck(request, env, corsHeaders) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.toLowerCase()?.trim();

  if (!email) {
    return new Response(
      JSON.stringify({ error: "Email parameter is required" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const record = await env.SUBSCRIPTIONS.get(`sub:${email}`);

  if (!record) {
    return new Response(
      JSON.stringify({
        email,
        isPremium: false,
        status: "none",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const subscription = JSON.parse(record);
  const isPremium =
    subscription.status === "active" || subscription.status === "trialing";

  return new Response(
    JSON.stringify({
      email: subscription.email,
      isPremium,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

/**
 * Verify Stripe webhook signature using Web Crypto API.
 * This replaces the need for the stripe npm package.
 */
async function verifyStripeSignature(payload, signatureHeader, secret) {
  try {
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((part) => {
        const [key, value] = part.split("=");
        return [key.trim(), value.trim()];
      })
    );

    const timestamp = parts.t;
    const signature = parts.v1;

    if (!timestamp || !signature) return false;

    // Reject events older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const expectedSignature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload)
    );

    const expectedHex = Array.from(new Uint8Array(expectedSignature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return expectedHex === signature;
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

/**
 * Build CORS headers based on the request origin and allowed origins config.
 */
function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim());

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
    "Access-Control-Max-Age": "86400",
  };

  if (allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}
