(() => {
  "use strict";
  function bytes(value) {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  window.NexoraNotifications = {
    async enable(api, config) {
      if (!config.push_notifications)
        throw new Error(
          "Background notifications are not available yet. Keep this page open for updates.",
        );
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error(
          "This browser does not support background notifications. Keep this page open for updates.",
        );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Notifications are off. You can change this in your browser settings.",
        );
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes(config.vapid_public_key),
        }));
      await api("/notifications/subscribe", {
        method: "POST",
        body: subscription.toJSON(),
      });
    },
    async disable(api) {
      if (!("serviceWorker" in navigator)) return;
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) return;
      try {
        await api("/notifications/unsubscribe", {
          method: "POST",
          body: { endpoint: subscription.endpoint },
          signal: AbortSignal.timeout(3000),
        });
      } finally {
        await subscription.unsubscribe();
      }
    },
  };
})();
