(() => {
  'use strict';
  const notices = document.querySelectorAll('[data-booking-availability]');
  if (!notices.length) return;
  fetch('/api/v1/config', { signal: AbortSignal.timeout(10000), cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      const config = await response.json();
      notices.forEach(notice => {
        notice.hidden = !!config.booking_available;
        notice.textContent = 'New bookings are not available yet. Existing customers and drivers can still sign in to view their records.';
      });
    })
    .catch(() => notices.forEach(notice => {
      notice.textContent = 'We could not check booking availability. Please try again shortly.';
    }));
})();
