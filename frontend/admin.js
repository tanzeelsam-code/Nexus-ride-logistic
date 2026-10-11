(() => {
  "use strict";
  const W = window.NexoraWorkspace,
    { $, esc, icon, api, empty } = W;
  let drivers = [],
    filter = "all",
    loading = false,
    session = 0;
  W.icons();
  function signedOut(message = "") {
    session++;
    $("account").hidden = true;
    $("auth").hidden = false;
    $("login-error").textContent = message;
    document.body.classList.remove("nav-open");
    document.querySelector("dialog[open]")?.close();
  }
  window.addEventListener("nexora:session-expired", () =>
    signedOut("Your session expired. Please sign in again."),
  );
  $("login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      const data = await api(
        "/auth/login",
        Object.fromEntries(new FormData(event.target)),
      );
      if (!["admin", "ops"].includes(data.user.role))
        throw new Error("Please sign in with an admin or operations account.");
      W.save(data);
      event.target.reset();
      if (new URLSearchParams(location.search).get("next") === "ops") {
        location.href = "ops.html";
        return;
      }
      await start();
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  async function start() {
    session++;
    $("auth").hidden = true;
    $("account").hidden = false;
    W.shell("admin");
    await refresh();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    const current = session;
    $("refresh").disabled = true;
    try {
      const data = await api("/admin/drivers");
      if (current !== session) return;
      drivers = data.drivers || [];
      render();
      $("load-error").hidden = true;
      $("connection").className = "connection live";
      $("connection").textContent = "Connected";
      $("updated").textContent =
        "Updated " +
        new Date().toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
    } catch (error) {
      if (current !== session) return;
      $("load-error").hidden = false;
      $("load-error").textContent =
        error.message + " Use Refresh to try again.";
      $("connection").className = "connection warning";
      $("connection").textContent = "Update unavailable";
      if (!drivers.length)
        $("drivers").innerHTML = empty(
          "users",
          "Unable to load drivers",
          "Your registrations will appear here when the connection is restored.",
        );
    } finally {
      loading = false;
      $("refresh").disabled = false;
    }
  }
  function render() {
    $("total-count").textContent = drivers.length;
    $("pending-count").textContent = drivers.filter(
      (d) => !d.onboarding_completed,
    ).length;
    $("approved-count").textContent = drivers.filter(
      (d) => d.onboarding_completed,
    ).length;
    $("driver-total").textContent = drivers.length + " registered";
    const query = $("search").value.trim().toLowerCase();
    const rows = drivers.filter(
      (d) =>
        (filter === "all" ||
          (filter === "approved"
            ? d.onboarding_completed
            : !d.onboarding_completed)) &&
        [d.first_name, d.last_name, d.email, d.phone]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
    if (!rows.length) {
      $("drivers").innerHTML = empty(
        "users",
        drivers.length ? "No matching drivers" : "Your next driver starts here",
        drivers.length
          ? "Try another name or choose a different filter."
          : "Share your signup link. New registrations will arrive here, ready for review.",
        drivers.length
          ? ""
          : '<button id="empty-invite">' +
              icon("link") +
              " Share signup link</button>",
      );
      $("empty-invite")?.addEventListener("click", share);
      return;
    }
    $("drivers").innerHTML =
      `<div class="table-scroll"><table><thead><tr><th scope="col">Driver</th><th scope="col">Contact</th><th scope="col">Services</th><th scope="col">Approval</th><th scope="col">Action</th></tr></thead><tbody>${rows.map((d) => `<tr><td><div class="person"><span class="avatar">${esc(W.initials(d.first_name + " " + d.last_name))}</span><div><strong>${esc(d.first_name)} ${esc(d.last_name)}</strong><small>${esc(d.driver_number || W.human(d.status))}</small></div></div></td><td>${esc(d.email)}<small>${esc(d.phone || "No phone provided")}</small></td><td>${esc((d.service_types || []).map(W.human).join(", ") || "Not specified")}</td><td><span class="badge ${d.status === "suspended" ? "red" : d.onboarding_completed ? "" : "amber"}">${d.status === "suspended" ? "Suspended" : d.onboarding_completed ? "Approved" : "Awaiting review"}</span></td><td><button data-review="${esc(d.id)}">${d.onboarding_completed ? "View details" : "Review application"} ${icon("arrow")}</button></td></tr>`).join("")}</tbody></table></div>`;
  }
  function share() {
    const url = new URL("driver-register.html", location.href).href;
    const dialog = W.dialog(
      "Invite a driver",
      `<p>Share this link with your driver. Their registration will appear here for review.</p><label>Driver signup link<input id="signup-link" readonly value="${esc(url)}"></label><div class="dialog-actions"><button class="primary" id="copy-signup">Copy link ${icon("link")}</button></div><p id="copy-result" role="status"></p>`,
    );
    dialog.querySelector("#copy-signup").onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        W.toast("Driver signup link copied.");
        dialog.close();
      } catch {
        $("signup-link").select();
        $("copy-result").textContent = "Select and copy the link above.";
      }
    };
  }
  $("invite").addEventListener("click", share);
  $("refresh").addEventListener("click", refresh);
  $("search").addEventListener("input", render);
  $("filters").addEventListener("click", (e) => {
    const button = e.target.closest("[data-filter]");
    if (!button) return;
    filter = button.dataset.filter;
    $("filters")
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    render();
  });
  $("drivers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-review]");
    if (!button) return;
    const d = drivers.find((d) => d.id === button.dataset.review);
    if (!d) return;
    const dialog = W.dialog(
      "Driver application",
      `<div class="person review-person"><span class="avatar">${esc(W.initials(d.first_name + " " + d.last_name))}</span><div><h3>${esc(d.first_name)} ${esc(d.last_name)}</h3><small>${esc(d.driver_number || "")}</small></div></div><div class="day-summary"><dl><div><dt>Email</dt><dd class="review-email">${esc(d.email)}</dd></div><div><dt>Phone</dt><dd>${esc(d.phone || "—")}</dd></div><div><dt>Services</dt><dd>${esc((d.service_types || []).map(W.human).join(", ") || "—")}</dd></div><div><dt>Background check</dt><dd>${esc(W.human(d.background_check_status || "Not recorded"))}</dd></div><div><dt>Account status</dt><dd>${esc(W.human(d.status))}</dd></div></dl></div><p class="login-footnote">Approval allows this driver to go online and accept jobs. Confirm that you have reviewed their details before continuing.</p><p id="approval-error" class="error-text" role="alert"></p><div class="dialog-actions"><button id="review-close">Close</button>${!d.onboarding_completed && d.status !== "suspended" ? '<button id="approve-driver" class="primary">' + icon("check") + " Approve driver</button>" : ""}</div>`,
    );
    dialog.querySelector("#review-close").onclick = () => dialog.close();
    dialog
      .querySelector("#approve-driver")
      ?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(
            "/admin/drivers/" + encodeURIComponent(d.id) + "/approve",
            {},
          );
          dialog.close();
          W.toast("Driver approved. They can now go online.");
          await refresh();
        } catch (error) {
          const errorEl = dialog.querySelector("#approval-error");
          if (errorEl) errorEl.textContent = error.message;
          const action = dialog.querySelector("#approve-driver");
          if (action) action.disabled = false;
        }
      });
  });
  if (W.get("token")) start();
})();
