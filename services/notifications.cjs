"use strict";
const webPush = require("web-push");
const { unavailable } = require("./maps.cjs");
const messages = {
  "trip:new_request": [
    "A new ride is waiting",
    "Open Nexora to review the pickup and fare.",
  ],
  "delivery:new_request": [
    "A new delivery is waiting",
    "Open Nexora to review this delivery.",
  ],
  "trip:driver_en_route": [
    "Your driver is on the way",
    "Follow their progress in Nexora.",
  ],
  "trip:driver_arrived": [
    "Your driver has arrived",
    "Check the vehicle before sharing your pickup PIN.",
  ],
  "trip:started": ["Your ride has started", "Have a good journey."],
  "trip:completed": [
    "You have arrived",
    "Your ride receipt is ready in Nexora.",
  ],
  "trip:dispatch_failed": [
    "No driver was available",
    "Open Nexora to request another ride.",
  ],
  "trip:cancelled": ["Ride cancelled", "Your job list has been updated."],
  "delivery:driver_assigned": [
    "Your delivery has a driver",
    "Open Nexora for the latest status.",
  ],
  "delivery:picked_up": [
    "Your delivery is on the way",
    "Your package has been picked up.",
  ],
  "delivery:delivered": [
    "Delivery completed",
    "Proof of delivery is ready in Nexora.",
  ],
  "delivery:cancelled": [
    "Delivery cancelled",
    "Your job list has been updated.",
  ],
};
function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed =
      host === "fcm.googleapis.com" ||
      host === "updates.push.services.mozilla.com" ||
      host === "web.push.apple.com" ||
      host.endsWith(".notify.windows.com");
    return (
      allowed &&
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      value.endpoint.length < 2048 &&
      /^[A-Za-z0-9_-]{87}$/.test(value.keys?.p256dh || "") &&
      /^[A-Za-z0-9_-]{22}$/.test(value.keys?.auth || "")
    );
  } catch {
    return false;
  }
}
function createNotifications({
  app,
  query,
  jobs,
  authenticate,
  requireDatabase,
  publicKey,
  privateKey,
  subject,
  fetch: request = globalThis.fetch,
}) {
  const enabled = !!(publicKey && privateKey && subject);
  const guard = [authenticate, requireDatabase];
  app.post(
    "/api/v1/notifications/subscribe",
    { preHandler: guard },
    async (req, reply) => {
      if (!enabled)
        throw unavailable(
          "Background notifications are temporarily unavailable.",
        );
      if (!validSubscription(req.body))
        return reply.code(400).send({ error: "Invalid push subscription" });
      const { endpoint, keys } = req.body;
      // A shared browser can switch accounts; ownership follows explicit opt-in.
      await query(
        `INSERT INTO push_subscriptions(user_id,endpoint,subscription) VALUES($1,$2,$3)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription=EXCLUDED.subscription`,
        [req.user.id, endpoint, { endpoint, keys }],
      );
      return { subscribed: true };
    },
  );
  app.post(
    "/api/v1/notifications/unsubscribe",
    { preHandler: guard },
    async (req) => {
      await query(
        "DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2",
        [String(req.body?.endpoint || ""), req.user.id],
      );
      return { subscribed: false };
    },
  );
  async function enqueue(audience, event, payload) {
    if (!enabled || !messages[event] || !/^(user|driver):/.test(audience))
      return;
    const [kind, id] = audience.split(":");
    const userId =
      kind === "user"
        ? id
        : (await query("SELECT user_id FROM drivers WHERE id=$1", [id])).rows[0]
            ?.user_id;
    if (!userId) return;
    const itemId = payload.trip_id || payload.delivery_id;
    await jobs.enqueue("push", `push:${audience}:${event}:${itemId}`, {
      user_id: userId,
      title: messages[event][0],
      body: messages[event][1],
      event,
      url: kind === "driver" ? "/driver.html" : "/customer.html",
      tag: `${event}:${itemId}`,
    });
  }
  async function deliver(job) {
    const offer = job.payload.event.endsWith("new_request");
    if (
      Date.now() - new Date(job.created_at).getTime() >
      (offer ? 20000 : 3600000)
    )
      return;
    const { rows } = await query(
      "SELECT * FROM push_subscriptions WHERE user_id=$1",
      [job.payload.user_id],
    );
    for (const row of rows) {
      if (!validSubscription(row.subscription)) continue;
      const { title, body, url, tag } = job.payload;
      const details = webPush.generateRequestDetails(
        row.subscription,
        JSON.stringify({ title, body, url, tag }),
        {
          TTL: offer ? 20 : 3600,
          urgency: "high",
          vapidDetails: { subject, publicKey, privateKey },
        },
      );
      const result = await request(details.endpoint, {
        method: "POST",
        headers: details.headers,
        body: details.body,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (result.status === 404 || result.status === 410)
        await query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
      else if (!result.ok)
        throw Object.assign(new Error("Push delivery failed"), {
          code: `push_${result.status}`,
        });
    }
  }
  return {
    enabled,
    enqueue,
    deliver,
    async sweep(limit = 10) {
      if (enabled) await jobs.run(["push"], deliver, limit);
    },
  };
}
module.exports = { createNotifications, validSubscription };
