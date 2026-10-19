(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const money = (value, currency = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(value || 0),
    );
  const activeStatuses = [
    "requested",
    "searching",
    "accepted",
    "driver_en_route",
    "arrived",
    "in_progress",
  ];
  const labels = {
    requested: "Finding your driver",
    searching: "Finding your driver",
    accepted: "Confirming your driver",
    driver_en_route: "Your driver is on the way",
    arrived: "Your driver has arrived",
    in_progress: "Enjoy your journey",
    completed: "You have arrived",
    cancelled: "Ride cancelled",
    failed: "No driver available",
  };
  let config = {},
    map,
    routeLayer,
    markers = {},
    pickMode = null,
    quote = null,
    bookingBody = null,
    paymentElements,
    stripe,
    paymentId = null,
    currentId = null,
    pollTimer,
    polling = false,
    tripVersion = 0,
    quoteVersion = 0;
  const points = { pickup: null, dropoff: null };
  const session = NexoraSession("nexora_customer", signedOut);
  const request = (path, body, headers) =>
    session.api(path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body }),
      headers,
    });
  const error = (id, err) =>
    ($(id).textContent = err?.message || String(err || ""));
  async function busy(button, fn) {
    button.disabled = true;
    try {
      await fn();
    } catch (err) {
      error("ride-error", err);
    } finally {
      button.disabled = false;
    }
  }
  function signedOut() {
    clearInterval(pollTimer);
    pollTimer = null;
    tripVersion++;
    currentId = null;
    quote = null;
    bookingBody = null;
    paymentElements?.getElement("payment")?.destroy();
    paymentElements = null;
    paymentId = null;
    quoteVersion++;
    $("account").hidden = true;
    $("auth").hidden = false;
    $("current").hidden = true;
    $("history").replaceChildren();
    error("login-error", "Please sign in to continue.");
  }
  function invalidateQuote() {
    quoteVersion++;
    quote = null;
    bookingBody = null;
    paymentId = null;
    paymentElements?.getElement("payment")?.destroy();
    paymentElements = null;
    $("quote").hidden = true;
    $("card-payment").hidden = true;
    $("payment-method").disabled = false;
    $("confirm-booking").textContent = "Confirm ride";
    session.set("pending_booking", null);
  }
  function ensureMap() {
    if (map) return;
    if (!window.L) {
      $("journey-map").textContent =
        "The map could not load. You can still search for your addresses.";
      return;
    }
    map = L.map("journey-map").setView([25, 20], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on("click", async (event) => {
      if (!pickMode) return;
      const kind = pickMode;
      pickMode = null;
      const point = {
        lat: event.latlng.lat,
        lng: event.latlng.lng,
        address: kind === "pickup" ? "Selected pickup" : "Selected destination",
      };
      selectPlace(kind, point);
      error(
        "map-caption",
        "Pin selected. Review your stops before checking the fare.",
      );
      try {
        const { place } = await request(
          "/places/reverse?" +
            new URLSearchParams({ lat: point.lat, lng: point.lng }),
        );
        if (place && points[kind] === point) {
          point.address = place.address;
          $(kind + "-address").value = place.address;
        }
      } catch {
        /* The chosen pin remains usable without a reverse geocoder. */
      }
    });
  }
  function marker(name, point) {
    if (!map) return;
    if (!point) {
      if (markers[name]) map.removeLayer(markers[name]);
      delete markers[name];
      return;
    }
    const lat = Number(point.lat),
      lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (markers[name]) markers[name].setLatLng([lat, lng]);
    else
      markers[name] = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "map-pin " + (name === "dropoff" ? "destination" : name),
          iconSize: [20, 20],
        }),
        title: name,
      }).addTo(map);
  }
  function fitMap() {
    const coords = Object.values(markers).map((m) => m.getLatLng());
    if (coords.length && map)
      map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 15 });
  }
  function drawRoute(geometry) {
    if (routeLayer) {
      map?.removeLayer(routeLayer);
      routeLayer = null;
    }
    if (map && geometry)
      routeLayer = L.geoJSON(geometry, {
        style: { color: "#21634c", weight: 5, opacity: 0.75 },
      }).addTo(map);
  }
  function selectPlace(kind, place) {
    points[kind] = place;
    $(kind + "-address").value = place.address;
    $(kind + "-results").replaceChildren();
    invalidateQuote();
    marker(kind, place);
    fitMap();
    error(
      "location-message",
      (kind === "pickup" ? "Pickup" : "Destination") + " selected.",
    );
  }
  for (const kind of ["pickup", "dropoff"]) {
    $("search-" + kind).addEventListener("click", () =>
      busy($("search-" + kind), async () => {
        const input = $(kind + "-address"),
          q = input.value.trim();
        if (q.length < 3)
          throw new Error("Enter a street, building, or area to search.");
        const { places } = await request(
          "/places/search?q=" + encodeURIComponent(q),
        );
        if (input.value.trim() !== q) return;
        $(kind + "-results").replaceChildren();
        if (!places.length)
          throw new Error(
            "No addresses found. Try a nearby street or choose a point on the map.",
          );
        for (const place of places) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = place.address;
          button.addEventListener("click", () => selectPlace(kind, place));
          $(kind + "-results").append(button);
        }
      }),
    );
    $(kind + "-address").addEventListener("input", () => {
      points[kind] = null;
      marker(kind, null);
      invalidateQuote();
    });
    $(kind + "-address").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("search-" + kind).click();
      }
    });
    $("pin-" + kind).addEventListener("click", () => {
      ensureMap();
      if (!map)
        return error(
          "ride-error",
          "The map could not load. Please search for the address.",
        );
      pickMode = kind;
      error(
        "map-caption",
        "Tap the map to choose your " +
          (kind === "pickup" ? "pickup" : "destination") +
          ".",
      );
      $("journey-map").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  $("locate").addEventListener("click", () =>
    busy($("locate"), async () => {
      if (!navigator.geolocation)
        throw new Error(
          "Location is unavailable. Search for your pickup instead.",
        );
      const p = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          resolve,
          () =>
            reject(
              new Error(
                "Location was unavailable. Search for your pickup or choose it on the map.",
              ),
            ),
          { enableHighAccuracy: true, timeout: 15000 },
        ),
      );
      const point = {
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        address: "My current location",
      };
      selectPlace("pickup", point);
      try {
        const { place } = await request(
          "/places/reverse?" +
            new URLSearchParams({ lat: point.lat, lng: point.lng }),
        );
        if (place && points.pickup === point) {
          point.address = place.address;
          $("pickup-address").value = place.address;
        }
      } catch {
        /* Device coordinates remain usable. */
      }
    }),
  );
  $("ride").addEventListener("submit", (event) => {
    event.preventDefault();
    busy($("estimate"), async () => {
      error("ride-error", "");
      if (!points.pickup || !points.dropoff)
        throw new Error(
          "Choose both addresses from the search results, or place both pins on the map.",
        );
      invalidateQuote();
      const version = quoteVersion;
      const body = {
        pickup_lat: points.pickup.lat,
        pickup_lng: points.pickup.lng,
        pickup_address: $("pickup-address").value.trim(),
        dropoff_lat: points.dropoff.lat,
        dropoff_lng: points.dropoff.lng,
        dropoff_address: $("dropoff-address").value.trim(),
        service_type: "taxi",
        passengers: 1,
        payment_method: "cash",
      };
      const result = await request("/trips/estimate", body);
      if (version !== quoteVersion) return;
      quote = result;
      bookingBody = body;
      const price = result.price_estimate;
      $("fare").textContent = money(price.total_fare, price.currency);
      $("route-summary").textContent =
        `${Number(price.route.distance_km).toFixed(1)} km · About ${Math.ceil(price.route.duration_minutes)} minute${Math.ceil(price.route.duration_minutes) === 1 ? "" : "s"} ${price.route.source === "approximate" ? "· Approximate preview route" : ""}`;
      $("quote-expiry").textContent =
        "This fare is held for 5 minutes. Traffic can change your arrival time.";
      $("quote").hidden = false;
      $("payment-method").value = "cash";
      $("confirm-booking").textContent = "Confirm ride";
      drawRoute(price.route.geometry);
      fitMap();
      $("quote").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
  let stripeLoading;
  function loadStripe() {
    if (window.Stripe) return Promise.resolve();
    if (!stripeLoading)
      stripeLoading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://js.stripe.com/v3/";
        script.onload = resolve;
        script.onerror = () => {
          stripeLoading = null;
          reject(new Error("Card checkout could not load. Please try again."));
        };
        document.head.append(script);
      });
    return stripeLoading;
  }
  $("payment-method").addEventListener("change", () =>
    busy($("confirm-booking"), async () => {
      error("ride-error", "");
      $("card-payment").hidden = $("payment-method").value !== "card";
      $("payment-note").textContent =
        $("payment-method").value === "cash"
          ? "Pay your driver at the end of your ride."
          : "Your card details are handled securely by Stripe.";
      if ($("payment-method").value !== "card" || paymentElements) return;
      if (!quote) throw new Error("Please check your fare again.");
      const version = quoteVersion;
      const authorized = await request("/payments/authorize", {
        quote_token: quote.quote_token,
      });
      await loadStripe();
      if (version !== quoteVersion) return;
      stripe = Stripe(authorized.publishable_key);
      paymentId = authorized.payment_intent_id;
      paymentElements = stripe.elements({
        clientSecret: authorized.client_secret,
        appearance: {
          theme: "stripe",
          variables: { colorPrimary: "#21634c", borderRadius: "10px" },
        },
      });
      paymentElements.create("payment").mount("#payment-element");
    }),
  );
  $("edit-journey").addEventListener("click", () => {
    invalidateQuote();
    $("ride").scrollIntoView({ behavior: "smooth" });
  });
  $("confirm-booking").addEventListener("click", () =>
    busy($("confirm-booking"), async () => {
      error("ride-error", "");
      const version = quoteVersion;
      const pending = session.get("pending_booking");
      let saved = pending ? JSON.parse(pending) : null;
      if (!saved) {
        if (!quote || Date.now() >= new Date(quote.expires_at).getTime()) {
          invalidateQuote();
          throw new Error("Your fare expired. Please check it again.");
        }
        const payment = $("payment-method").value;
        if (payment === "card") {
          if (!paymentElements)
            throw new Error(
              "Card checkout is not ready. Choose cash or try selecting card again.",
            );
          const result = await stripe.confirmPayment({
            elements: paymentElements,
            redirect: "if_required",
            confirmParams: { return_url: location.origin + "/customer.html" },
          });
          if (version !== quoteVersion)
            throw new Error(
              "Your journey changed. Please check your fare again.",
            );
          if (result.error) throw new Error(result.error.message);
          if (result.paymentIntent?.status !== "requires_capture")
            throw new Error(
              "Your card has not been authorized. Please try again.",
            );
          paymentId = result.paymentIntent.id;
        }
        saved = {
          key: crypto.randomUUID(),
          quote,
          body: {
            ...bookingBody,
            quote_token: quote.quote_token,
            payment_method: payment,
            ...(payment === "card" ? { payment_intent_id: paymentId } : {}),
          },
        };
        session.set("pending_booking", JSON.stringify(saved));
      }
      try {
        const result = await request("/trips", saved.body, {
          "Idempotency-Key": saved.key,
        });
        session.set("pending_booking", null);
        currentId = result.trip.id;
        session.set("trip", currentId);
        invalidateQuote();
        await showTrip();
        await history();
        $("current").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        if (err.status && err.status < 500) {
          session.set("pending_booking", null);
          await history();
        } else
          error(
            "ride-error",
            "We could not confirm the response. Select Confirm ride again to safely retry the same booking.",
          );
        throw err;
      }
    }),
  );
  async function showTrip() {
    if (!currentId || polling) return;
    polling = true;
    const id = currentId,
      version = tripVersion;
    try {
      const { trip: t } = await request("/trips/" + encodeURIComponent(id));
      if (id !== currentId || version !== tripVersion) return;
      const active = activeStatuses.includes(t.status);
      $("ride").hidden = active;
      $("current").hidden = false;
      $("current").innerHTML =
        `<span class="trip-status">${esc(labels[t.status] || t.status)}</span><h2>${esc(t.pickup_address)} → ${esc(t.dropoff_address)}</h2><p>${esc(t.driver_name || "We are looking for a nearby driver.")} ${esc(t.plate_number || "")}</p>${["driver_en_route", "arrived", "accepted"].includes(t.status) ? `<p>Share this PIN only after checking your driver and vehicle.</p><div class="pin-code">${esc(t.pickup_otp)}</div>` : ""}<dl class="ride-details"><div><dt>Fare</dt><dd>${money(t.total_fare, t.currency)}</dd></div><div><dt>Payment</dt><dd>${t.payment_method === "cash" ? "Cash to driver" : esc(t.payment_status === "captured" ? "Paid" : t.payment_status === "failed" ? "Payment needs attention" : t.payment_status === "authorized" ? "Card authorized" : "Payment processing")}</dd></div></dl>${t.driver_phone && active ? `<p><a href="tel:${esc(t.driver_phone)}">Call your driver</a></p>` : ""}${active && t.status !== "in_progress" ? '<button id="cancel-ride" class="secondary">Cancel ride</button>' : ""}${t.status === "failed" ? "<p>No driver was available nearby. You can try again shortly. Any unused card hold will be released.</p>" : ""}${t.status === "completed" && !t.customer_rating ? '<h3>How was your journey?</h3><div class="rating-options">' + [1, 2, 3, 4, 5].map((n) => `<button data-rating="${n}" aria-label="Rate ${n} out of 5">${n} ★</button>`).join("") + "</div>" : ""}${!active ? '<button id="new-ride">Plan another ride →</button>' : ""}`;
      marker("pickup", { lat: t.pickup_lat, lng: t.pickup_lng });
      marker("dropoff", { lat: t.dropoff_lat, lng: t.dropoff_lng });
      marker(
        "driver",
        t.driver_lat != null && t.driver_lng != null
          ? { lat: t.driver_lat, lng: t.driver_lng }
          : null,
      );
      drawRoute(t.route_geometry);
      if (
        !$("current").dataset.fitted ||
        $("current").dataset.fitted !== t.id
      ) {
        fitMap();
        $("current").dataset.fitted = t.id;
      }
      error(
        "map-caption",
        active
          ? t.driver_lat != null
            ? "Driver location updated " +
              new Date(t.driver_location_updated_at).toLocaleTimeString()
            : "Waiting for a recent driver location."
          : "Journey " + t.status + ".",
      );
      $("cancel-ride")?.addEventListener("click", () =>
        busy($("cancel-ride"), async () => {
          await request("/trips/" + id + "/cancel", {});
          await showTrip();
          await history();
        }),
      );
      $("new-ride")?.addEventListener("click", () => {
        currentId = null;
        session.set("trip", null);
        tripVersion++;
        clearInterval(pollTimer);
        pollTimer = null;
        $("current").hidden = true;
        $("ride").hidden = false;
        marker("driver", null);
      });
      document.querySelectorAll("[data-rating]").forEach((button) =>
        button.addEventListener("click", () =>
          busy(button, async () => {
            await request("/trips/" + id + "/rate", {
              rating: Number(button.dataset.rating),
            });
            await showTrip();
          }),
        ),
      );
      if (active && !pollTimer)
        pollTimer = setInterval(() => {
          if (!document.hidden)
            showTrip().catch((err) =>
              error("ride-error", "Showing the last update. " + err.message),
            );
        }, 5000);
      if (!active) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } finally {
      polling = false;
    }
  }
  async function history() {
    const { trips } = await request("/trips");
    $("history").innerHTML = trips.length
      ? trips
          .map(
            (t) =>
              `<article class="row"><strong>${esc(labels[t.status] || t.status)}</strong><p>${esc(t.pickup_address)} → ${esc(t.dropoff_address)}</p><p>${money(t.total_fare, t.currency)}</p><button class="secondary" data-trip="${esc(t.id)}">View journey</button></article>`,
          )
          .join("")
      : "Your first journey is ahead of you.";
    const active = trips.find((t) => activeStatuses.includes(t.status));
    if (active && currentId !== active.id) {
      currentId = active.id;
      session.set("trip", currentId);
      tripVersion++;
      await showTrip();
    }
    return trips;
  }
  $("history").addEventListener("click", (event) => {
    const button = event.target.closest("[data-trip]");
    if (!button) return;
    tripVersion++;
    currentId = button.dataset.trip;
    session.set("trip", currentId);
    showTrip().catch((err) => error("ride-error", err));
  });
  $("refresh").addEventListener("click", () =>
    history().catch((err) => error("ride-error", err)),
  );
  $("notifications").addEventListener("click", () =>
    busy($("notifications"), async () => {
      await NexoraNotifications.enable(session.api, config);
      error("notification-message", "Ride alerts are on for this browser.");
    }),
  );
  $("logout").addEventListener("click", async () => {
    await NexoraNotifications.disable(session.api).catch(() => {});
    session.logout();
    signedOut();
    error("login-error", "");
  });
  async function start() {
    $("auth").hidden = true;
    $("account").hidden = false;
    $("name").textContent = session.get("name") || "there";
    error("login-error", "");
    ensureMap();
    map?.invalidateSize();
    config = await request("/config");
    $("card-option").disabled = !config.card_payments;
    $("card-option").textContent = config.card_payments
      ? "Card"
      : "Card · currently unavailable";
    currentId = session.get("trip");
    const trips = await history();
    if (currentId) await showTrip();
    const raw = session.get("pending_booking");
    if (raw) {
      const saved = JSON.parse(raw);
      if (trips.some((t) => activeStatuses.includes(t.status)))
        session.set("pending_booking", null);
      else if (saved.quote) {
        $("quote").hidden = false;
        $("fare").textContent = money(
          saved.quote.price_estimate.total_fare,
          saved.quote.price_estimate.currency,
        );
        $("payment-method").value = saved.body.payment_method;
        $("payment-method").disabled = true;
        $("confirm-booking").textContent = "Retry booking";
        $("quote-expiry").textContent =
          "Your previous request was interrupted. Retry to safely check the same booking.";
      }
    }
  }
  for (const formId of ["login", "registration"])
    $(formId).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target,
        button = form.querySelector("button"),
        messageId = formId === "login" ? "login-error" : "message";
      button.disabled = true;
      error(messageId, "");
      try {
        const data = await request(
          "/auth/" + (formId === "login" ? "login" : "register"),
          Object.fromEntries(new FormData(form)),
        );
        if (data.user.role !== "customer") {
          session.save(data);
          session.logout();
          throw new Error("Please use a customer account here.");
        }
        session.save(data);
        form.reset();
        await start();
      } catch (err) {
        error(messageId, err);
      } finally {
        button.disabled = false;
      }
    });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !session.get("token")) signedOut();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentId)
      showTrip().catch((err) => error("ride-error", err));
  });
  if (session.get("token")) start().catch((err) => error("ride-error", err));
})();
