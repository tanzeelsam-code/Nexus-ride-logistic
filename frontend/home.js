(() => {
  "use strict";
  let service = "ride";
  const form = document.getElementById("start-journey");
  document.querySelectorAll("[data-service]").forEach((button) =>
    button.addEventListener("click", () => {
      service = button.dataset.service;
      document
        .querySelectorAll("[data-service]")
        .forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
      document.getElementById("start-label").textContent =
        service === "ride" ? "Continue with ride" : "Continue with delivery";
      document.getElementById("destination-label").textContent =
        service === "ride" ? "Where to?" : "Delivery address";
      document.getElementById("booking-hint").textContent =
        service === "ride"
          ? "Choose your stops. Review the fare before you book."
          : "Choose your stops. Add package details on the next step.";
    }),
  );
  document.getElementById("swap-stops").addEventListener("click", () => {
    const pickup = form.elements.pickup,
      dropoff = form.elements.dropoff;
    [pickup.value, dropoff.value] = [dropoff.value, pickup.value];
    pickup.focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const saved = NexoraUI.drafts.save({
      service,
      pickup: form.elements.pickup.value.trim(),
      dropoff: form.elements.dropoff.value.trim(),
    });
    if (!saved) {
      document.getElementById("draft-error").textContent =
        "Enable browser storage to carry your stops to the next step, or open Book a ride / Send a package above.";
      return;
    }
    location.assign(service === "ride" ? "/customer.html" : "/freight.html");
  });
})();
