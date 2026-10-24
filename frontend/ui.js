/* Shared, accessible product controls. No credentials or addresses in URLs. */
(() => {
  "use strict";
  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`;
  const draftKey = "nexora_journey_draft";
  const drafts = {
    save(value) {
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ ...value, expires: Date.now() + 30 * 60 * 1000 }),
        );
        return true;
      } catch {
        return false;
      }
    },
    take(service) {
      try {
        const value = JSON.parse(sessionStorage.getItem(draftKey));
        if (!value || value.expires < Date.now()) {
          sessionStorage.removeItem(draftKey);
          return null;
        }
        if (value.service !== service) return null;
        sessionStorage.removeItem(draftKey);
        return {
          pickup: String(value.pickup || "").slice(0, 200),
          dropoff: String(value.dropoff || "").slice(0, 200),
        };
      } catch {
        return null;
      }
    },
  };
  function ask({
    title,
    message,
    confirm = "Continue",
    input = false,
    digits = 6,
  }) {
    const pinLength = digits === 4 ? 4 : 6;
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const dialog = document.createElement("dialog");
      dialog.className = "nexora-dialog";
      dialog.setAttribute("aria-labelledby", "action-dialog-title");
      dialog.setAttribute("aria-describedby", "action-dialog-message");
      dialog.innerHTML = `<form method="dialog"><h2 id="action-dialog-title"></h2><p id="action-dialog-message"></p>${input ? `<label>${pinLength}-digit PIN<input name="pin" inputmode="numeric" pattern="[0-9]{${pinLength}}" minlength="${pinLength}" maxlength="${pinLength}" autocomplete="one-time-code" required></label>` : ""}<div class="dialog-actions"><button class="secondary" value="cancel" formnovalidate>Go back</button><button value="confirm"></button></div></form>`;
      dialog.querySelector("h2").textContent = title;
      dialog.querySelector("p").textContent = message;
      dialog.querySelector('[value="confirm"]').textContent = confirm;
      document.body.append(dialog);
      dialog.addEventListener(
        "close",
        () => {
          const answer =
            dialog.returnValue === "confirm"
              ? input
                ? dialog.querySelector("input").value
                : true
              : null;
          dialog.remove();
          previous?.focus();
          resolve(answer);
        },
        { once: true },
      );
      dialog.showModal();
      (
        dialog.querySelector("input") ||
        dialog.querySelector('[value="cancel"]')
      ).focus();
    });
  }
  function stepper(element, step) {
    element?.querySelectorAll("[data-step]").forEach((item) => {
      const index = Number(item.dataset.step);
      item.classList.toggle("complete", index < step);
      if (index === step) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  }
  document.querySelectorAll("[data-site-footer]").forEach((footer) => {
    footer.classList.add("site-footer");
    footer.innerHTML =
      '<div><a class="footer-brand" href="/">nexora</a><p>A little closer. Every journey.</p></div><div class="footer-links"><a href="/help.html">Help & safety</a><a href="/help.html#coverage">Service areas</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/driver.html">Driver sign in</a><a href="/admin.html">Team workspace</a></div>';
  });
  if (
    document.querySelector(
      "[data-service-areas], [data-support], [data-business]",
    )
  ) {
    fetch("/service-info.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((info) => {
        document.querySelectorAll("[data-service-areas]").forEach((el) => {
          el.textContent = info.service_areas?.length
            ? info.service_areas.join(" · ")
            : "Launch locations have not been announced. Check back here before planning a booking.";
        });
        document.querySelectorAll("[data-business]").forEach((el) => {
          el.textContent =
            info.legal_business_name ||
            "Business details will be published before public bookings open.";
        });
        document.querySelectorAll("[data-support]").forEach((el) => {
          if (
            typeof info.support_email === "string" &&
            /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(info.support_email)
          ) {
            const link = document.createElement("a");
            link.href = "mailto:" + info.support_email;
            link.textContent = info.support_email;
            el.replaceChildren(link);
          }
        });
      })
      .catch(() => {});
  }
  window.NexoraUI = { icon, ask, drafts, stepper };
})();
