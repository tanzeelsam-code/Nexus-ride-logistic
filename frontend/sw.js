/* No API or account data is cached. Notifications contain no PINs or addresses. */
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }
  const url = ["/customer.html", "/driver.html"].includes(data.url)
    ? data.url
    : "/";
  event.waitUntil(
    self.registration.showNotification(String(data.title || "Nexora"), {
      body: String(data.body || "You have an update."),
      tag: String(data.tag || "nexora"),
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin)
    .href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) =>
          new URL(client.url).pathname.replace(/\.html$/, "") ===
          new URL(url).pathname.replace(/\.html$/, ""),
      );
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
