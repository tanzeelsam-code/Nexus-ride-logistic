"use strict";
const { unavailable } = require("./maps.cjs");

function createPayments({
  app,
  query,
  transaction,
  stripe,
  jobs,
  enabled,
  publicKey,
  appUrl,
  connectCountry,
  authenticate,
  requireDatabase,
  requireDriver,
  idempotencyGuard,
  readQuote,
}) {
  const guard = [authenticate, requireDatabase];
  const configured = () => {
    if (!enabled)
      throw unavailable(
        "Card payments are currently unavailable. Please choose cash.",
      );
  };
  const cents = (value) => Math.round(Number(value) * 100);
  async function customer(user) {
    const {
      rows: [row],
    } = await query("SELECT stripe_customer_id FROM users WHERE id=$1", [
      user.id,
    ]);
    if (row.stripe_customer_id) return row.stripe_customer_id;
    const value = await stripe.customers.create(
      {
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
        metadata: { nexora_user_id: user.id },
      },
      { idempotencyKey: `customer:${user.id}` },
    );
    await query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [
      value.id,
      user.id,
    ]);
    return value.id;
  }
  app.post(
    "/api/v1/payments/authorize",
    { preHandler: [...guard, idempotencyGuard] },
    async (req, reply) => {
      configured();
      if (req.user.role !== "customer")
        return reply.code(403).send({ error: "Customer account required" });
      const quote = readQuote(req.body?.quote_token);
      const stripeCustomer = await customer(req.user);
      const intent = await stripe.paymentIntents.create(
        {
          amount: cents(quote.pricing.total_fare),
          currency: quote.pricing.currency.toLowerCase(),
          customer: stripeCustomer,
          capture_method: "manual",
          payment_method_types: ["card"],
          metadata: {
            nexora_user_id: req.user.id,
            quote_hash: quote.fingerprint,
          },
        },
        { idempotencyKey: `authorize:${req.user.id}:${quote.jti}` },
      );
      await query(
        `INSERT INTO booking_payments(intent_id,customer_id,quote_hash,amount_cents,currency,expires_at)
      VALUES($1,$2,$3,$4,$5,to_timestamp($6)) ON CONFLICT(intent_id) DO NOTHING`,
        [
          intent.id,
          req.user.id,
          quote.fingerprint,
          intent.amount,
          intent.currency,
          quote.exp,
        ],
      );
      return {
        client_secret: intent.client_secret,
        payment_intent_id: intent.id,
        publishable_key: publicKey,
      };
    },
  );

  async function verifyAuthorization(userId, intentId, quote) {
    configured();
    if (!/^pi_[A-Za-z0-9]+$/.test(intentId || ""))
      throw unavailable("Please authorize your card before booking.", 400);
    const {
      rows: [booking],
    } = await query(
      "SELECT * FROM booking_payments WHERE intent_id=$1 AND customer_id=$2",
      [intentId, userId],
    );
    if (
      !booking ||
      booking.trip_id ||
      new Date(booking.expires_at).getTime() <= Date.now() ||
      booking.quote_hash !== quote.fingerprint
    ) {
      throw unavailable(
        "This payment authorization is expired or already used. Please get a new fare.",
        409,
      );
    }
    const pi = await stripe.paymentIntents.retrieve(intentId);
    if (
      pi.status !== "requires_capture" ||
      pi.capture_method !== "manual" ||
      pi.metadata.nexora_user_id !== userId ||
      pi.metadata.quote_hash !== quote.fingerprint ||
      pi.amount !== cents(quote.pricing.total_fare) ||
      pi.amount_capturable !== pi.amount ||
      pi.currency !== quote.pricing.currency.toLowerCase()
    ) {
      throw unavailable(
        "The card authorization does not match this booking. Please try again.",
        409,
      );
    }
    return pi;
  }

  async function recordCapture(pi) {
    if (pi.status !== "succeeded") return;
    await transaction(async (client) => {
      const {
        rows: [trip],
      } = await client.query(
        "SELECT * FROM trips WHERE stripe_payment_intent_id=$1 FOR UPDATE",
        [pi.id],
      );
      if (!trip || trip.status !== "completed") return;
      if (
        pi.amount_received !== cents(trip.total_fare) ||
        pi.currency !== trip.currency.toLowerCase()
      )
        throw new Error("capture_amount_mismatch");
      if (["disputed", "refunded"].includes(trip.payment_status)) return;
      await client.query(
        "UPDATE payments SET status='captured',captured_at=COALESCE(captured_at,NOW()) WHERE gateway_ref=$1",
        [pi.id],
      );
      await client.query(
        "UPDATE trips SET payment_status='captured' WHERE id=$1",
        [trip.id],
      );
      const charge =
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : pi.latest_charge?.id;
      if (!charge) throw new Error("capture_charge_missing");
      const {
        rows: [settlement],
      } = await client.query(
        `INSERT INTO driver_settlements(trip_id,driver_id,amount_cents,currency,charge_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(trip_id) DO NOTHING RETURNING *`,
        [
          trip.id,
          trip.driver_id,
          cents(trip.driver_earnings),
          pi.currency,
          charge,
        ],
      );
      if (settlement) {
        await client.query(
          "UPDATE drivers SET pending_payout=pending_payout+$1 WHERE id=$2",
          [settlement.amount_cents / 100, trip.driver_id],
        );
        await jobs.enqueue(
          "transfer",
          `transfer:${trip.id}`,
          { trip_id: trip.id },
          client,
        );
      }
    });
  }

  async function handleJob(job) {
    configured();
    if (job.kind === "capture") {
      const {
        rows: [trip],
      } = await query("SELECT * FROM trips WHERE id=$1", [job.payload.trip_id]);
      if (
        !trip ||
        trip.status !== "completed" ||
        !trip.stripe_payment_intent_id
      )
        return;
      let pi = await stripe.paymentIntents.retrieve(
        trip.stripe_payment_intent_id,
      );
      if (pi.status === "requires_capture")
        pi = await stripe.paymentIntents.capture(
          pi.id,
          { amount_to_capture: cents(trip.total_fare) },
          { idempotencyKey: `capture:${trip.id}` },
        );
      if (pi.status === "succeeded") return recordCapture(pi);
      if (pi.status === "canceled") {
        await query("UPDATE trips SET payment_status='failed' WHERE id=$1", [
          trip.id,
        ]);
        await query(
          "UPDATE payments SET status='failed',failed_at=NOW() WHERE gateway_ref=$1",
          [pi.id],
        );
        return;
      }
      throw new Error("capture_pending");
    }
    if (job.kind === "cancel_authorization") {
      const {
        rows: [booking],
      } = await query(
        `SELECT b.*,t.status FROM booking_payments b LEFT JOIN trips t ON t.id=b.trip_id WHERE b.intent_id=$1`,
        [job.payload.intent_id],
      );
      if (
        !booking ||
        (booking.trip_id && !["failed", "cancelled"].includes(booking.status))
      )
        return;
      if (
        !booking.trip_id &&
        new Date(booking.expires_at).getTime() > Date.now()
      )
        throw new Error("authorization_not_expired");
      const pi = await stripe.paymentIntents.retrieve(booking.intent_id);
      if (!["succeeded", "canceled"].includes(pi.status))
        await stripe.paymentIntents.cancel(
          pi.id,
          {},
          { idempotencyKey: `cancel:${pi.id}` },
        );
      return;
    }
    if (job.kind === "transfer") {
      const {
        rows: [settlement],
      } = await query(
        `SELECT s.*,d.stripe_account_id,t.payment_status FROM driver_settlements s
        JOIN drivers d ON d.id=s.driver_id JOIN trips t ON t.id=s.trip_id WHERE s.trip_id=$1`,
        [job.payload.trip_id],
      );
      if (!settlement || settlement.transfer_id || settlement.blocked_reason)
        return;
      if (settlement.payment_status !== "captured") return;
      if (!settlement.stripe_account_id)
        throw Object.assign(new Error("Driver onboarding required"), {
          code: "connect_onboarding_required",
        });
      const account = await stripe.accounts.retrieve(
        settlement.stripe_account_id,
      );
      if (
        !account.payouts_enabled ||
        account.capabilities?.transfers !== "active"
      )
        throw Object.assign(new Error("Driver onboarding required"), {
          code: "connect_onboarding_required",
        });
      const prior = await stripe.transfers.list({
        transfer_group: `trip_${settlement.trip_id}`,
        limit: 100,
      });
      const existing = prior.data.find(
        (t) =>
          t.metadata?.trip_id === settlement.trip_id &&
          t.destination === settlement.stripe_account_id &&
          t.amount === settlement.amount_cents &&
          !t.reversed,
      );
      const transfer =
        existing ||
        (await stripe.transfers.create(
          {
            amount: settlement.amount_cents,
            currency: settlement.currency,
            destination: settlement.stripe_account_id,
            source_transaction: settlement.charge_id,
            metadata: { trip_id: settlement.trip_id },
            transfer_group: `trip_${settlement.trip_id}`,
          },
          { idempotencyKey: `transfer:${settlement.trip_id}` },
        ));
      await transaction(async (client) => {
        const result = await client.query(
          `UPDATE driver_settlements SET transfer_id=$1,transferred_at=NOW() WHERE id=$2 AND transfer_id IS NULL RETURNING id`,
          [transfer.id, settlement.id],
        );
        if (result.rowCount)
          await client.query(
            "UPDATE drivers SET pending_payout=GREATEST(0,pending_payout-$1) WHERE id=$2",
            [settlement.amount_cents / 100, settlement.driver_id],
          );
      });
    }
  }

  app.get(
    "/api/v1/driver/payouts",
    { preHandler: [...guard, requireDriver] },
    async (req) => {
      const {
        rows: [driver],
      } = await query("SELECT stripe_account_id FROM drivers WHERE id=$1", [
        req.driver.id,
      ]);
      let ready = false;
      if (enabled && driver.stripe_account_id) {
        const account = await stripe.accounts.retrieve(
          driver.stripe_account_id,
        );
        ready =
          account.payouts_enabled &&
          account.capabilities?.transfers === "active";
        if (ready)
          await query(
            `UPDATE background_jobs SET attempts=0,available_at=NOW(),last_error=NULL
        WHERE kind='transfer' AND completed_at IS NULL AND last_error='connect_onboarding_required'
        AND payload->>'trip_id' IN (SELECT trip_id::text FROM driver_settlements WHERE driver_id=$1 AND transfer_id IS NULL)`,
            [req.driver.id],
          );
      }
      const { rows } = await query(
        "SELECT trip_id,amount_cents,currency,transferred_at,blocked_reason FROM driver_settlements WHERE driver_id=$1 ORDER BY id DESC LIMIT 50",
        [req.driver.id],
      );
      return {
        enabled,
        connected: !!driver.stripe_account_id,
        ready,
        settlements: rows,
      };
    },
  );
  app.post(
    "/api/v1/driver/payouts/onboard",
    { preHandler: [...guard, requireDriver] },
    async (req) => {
      configured();
      if (
        !/^https:\/\//.test(appUrl) ||
        !/^[A-Z]{2}$/.test(connectCountry || "")
      )
        throw unavailable(
          "Driver payouts are not available yet. Please contact support.",
        );
      const {
        rows: [driver],
      } = await query("SELECT stripe_account_id FROM drivers WHERE id=$1", [
        req.driver.id,
      ]);
      let accountId = driver.stripe_account_id;
      if (!accountId) {
        const account = await stripe.accounts.create(
          {
            type: "express",
            country: connectCountry,
            email: req.user.email,
            capabilities: { transfers: { requested: true } },
            metadata: { nexora_driver_id: req.driver.id },
          },
          { idempotencyKey: `connect:${req.driver.id}` },
        );
        accountId = account.id;
        await query("UPDATE drivers SET stripe_account_id=$1 WHERE id=$2", [
          accountId,
          req.driver.id,
        ]);
      }
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        refresh_url: `${appUrl}/driver.html?payouts=refresh`,
        return_url: `${appUrl}/driver.html?payouts=return`,
      });
      return { url: link.url };
    },
  );

  async function handleEvent(event) {
    const object = event.data.object;
    if (event.type === "payment_intent.succeeded") return recordCapture(object);
    if (
      ["payment_intent.payment_failed", "payment_intent.canceled"].includes(
        event.type,
      )
    ) {
      await query(
        "UPDATE payments SET status='failed',failed_at=NOW() WHERE gateway_ref=$1 AND status NOT IN ('captured','refunded','disputed')",
        [object.id],
      );
      await query(
        "UPDATE trips SET payment_status='failed' WHERE stripe_payment_intent_id=$1 AND payment_status NOT IN ('captured','refunded','disputed')",
        [object.id],
      );
    }
    if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.refunded"
    ) {
      const charge =
        event.type === "charge.refunded" ? object.id : object.charge;
      const intentId =
        typeof object.payment_intent === "string"
          ? object.payment_intent
          : object.payment_intent?.id;
      const status = event.type === "charge.refunded" ? "refunded" : "disputed";
      await transaction(async (client) => {
        // Events may arrive before the capture handler creates a settlement.
        const { rows: affected } = await client.query(
          `UPDATE trips SET payment_status=$1
          WHERE stripe_payment_intent_id=$2 OR id IN (SELECT trip_id FROM driver_settlements WHERE charge_id=$3)
          RETURNING id`,
          [status, intentId || null, charge],
        );
        for (const trip of affected) {
          await client.query("UPDATE payments SET status=$1 WHERE trip_id=$2", [
            status,
            trip.id,
          ]);
          await client.query(
            "UPDATE driver_settlements SET blocked_reason=$1 WHERE trip_id=$2",
            [status, trip.id],
          );
        }
        // Sent transfers require manual review/reversal in Stripe; never send them again.
      });
    }
  }
  async function sweep(limit = 10) {
    if (!enabled) return;
    const { rows } =
      await query(`SELECT b.intent_id FROM booking_payments b LEFT JOIN trips t ON t.id=b.trip_id
      WHERE ((b.trip_id IS NULL AND b.expires_at<NOW()) OR t.status IN ('failed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.dedupe_key='cancel:'||b.intent_id) ORDER BY b.created_at LIMIT 100`);
    for (const row of rows)
      await jobs.enqueue("cancel_authorization", `cancel:${row.intent_id}`, {
        intent_id: row.intent_id,
      });
    await jobs.run(
      ["capture", "cancel_authorization", "transfer"],
      handleJob,
      limit,
    );
  }
  return {
    enabled,
    verifyAuthorization,
    recordCapture,
    handleEvent,
    handleJob,
    sweep,
    customer,
  };
}
module.exports = { createPayments };
