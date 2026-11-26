/* Shared, backend-controlled slot presentation. A snapshot never guarantees a reservation. */
(function (root) {
  "use strict";
  const times = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
  const label = time => `${Number(time.slice(0, 2)) % 12 || 12}:00 ${time < "12:00" ? "AM" : "PM"}`;
  function today() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function picker({ service, date, input, container, status, base, request = root.fetch.bind(root), select = false, recovery = () => false, changed = () => {}, refreshControl = null }) {
    let generation = 0, snapshot = null, loading = false;
    const clear = () => { snapshot = null; input.value = ""; changed(); };
    const ready = () => !loading && snapshot?.service === service() && snapshot?.date === date.value;
    const selected = () => recovery()
      ? Boolean(service() && date.value && times.includes(input.value))
      : ready() && snapshot.slots.some(slot => slot.time === input.value && slot.status === "available");
    function syncRecovery() {
      if (!recovery()) return;
      ++generation; snapshot = null; loading = false;
      status.textContent = "Recovery only: enter the original service, date and time, even if elapsed or occupied. No new appointment will be created.";
      render();
    }
    function render(focusTime) {
      if (refreshControl) {
        refreshControl.disabled = loading || recovery() || !service() || !date.value;
        refreshControl.setAttribute("aria-busy", String(loading));
        refreshControl.textContent = loading ? "Checking…" : "↻ Refresh";
      }
      if (!container) return;
      const available = ready();
      if (select) {
        for (const option of Array.from(input.options)) {
          if (!option.value) continue;
          const slot = snapshot?.slots.find(item => item.time === option.value);
          option.disabled = !available || slot?.status !== "available";
          option.textContent = `${label(option.value)}${slot?.status === "occupied" ? " — Fully Booked" : option.disabled ? " — Unavailable" : ""}`;
        }
        input.disabled = !available;
        input.dispatchEvent(new Event("change"));
      } else {
        container.replaceChildren();
        for (const time of times) {
          const slot = snapshot?.slots.find(item => item.time === time);
          const button = document.createElement("button");
          button.type = "button"; button.className = "appointment-slot";
          button.disabled = recovery() ? !service() || !date.value : !available || slot?.status !== "available";
          button.textContent = `${label(time)} · ${recovery() ? "Original request time" : slot?.status === "occupied" ? "Fully Booked" : slot?.status === "past" ? "Past" : button.disabled ? "Unavailable" : "Available"}`;
          button.setAttribute("aria-pressed", String(input.value === time));
          button.addEventListener("click", () => {
            if ((!recovery() && !ready()) || button.disabled) return;
            input.value = time; changed(); render(time);
          });
          container.appendChild(button);
          if (time === focusTime) button.focus?.();
        }
      }
    }
    async function refresh({ preserveSelection = false } = {}) {
      if (recovery()) { syncRecovery(); changed(); return; }
      const requestGeneration = ++generation;
      const previousTime = preserveSelection ? input.value : "";
      clear(); loading = true;
      status.textContent = service() && date.value ? "Checking service availability…" : "Select a service and date to see available times.";
      render();
      if (!service() || !date.value) { loading = false; if (refreshControl) render(); return; }
      const wantedService = service(), wantedDate = date.value;
      try {
        const response = await request(`${base()}/appointments/availability?service=${encodeURIComponent(wantedService)}&date=${encodeURIComponent(wantedDate)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
        const data = await response.json();
        if (requestGeneration !== generation) return;
        if (!response.ok || data.success !== true) throw new Error(data.message || "Availability is temporarily unavailable.");
        if (data.service !== wantedService || data.date !== wantedDate || !Array.isArray(data.slots) || data.slots.length !== times.length ||
          new Set(data.slots.map(slot => slot.time)).size !== times.length || data.slots.some(slot => !times.includes(slot.time) || !["available", "occupied", "past"].includes(slot.status))) {
          throw new Error("The server did not confirm availability. Please retry.");
        }
        snapshot = data; loading = false;
        if (data.slots.some(slot => slot.time === previousTime && slot.status === "available")) input.value = previousTime;
        status.textContent = data.slots.some(slot => slot.status === "available") ? "Times shown in Philippine time. Your slot is confirmed only after submission." : "No available times for this service and date. Choose another date.";
      } catch (error) {
        if (requestGeneration !== generation) return;
        snapshot = null; loading = false;
        status.textContent = error.message || "Unable to check availability. Please retry.";
      }
      render(); changed();
    }
    return { refresh, selected, ready, syncRecovery, reset() { ++generation; loading = false; clear(); render(); } };
  }
  root.AppointmentSlots = { picker, today, label, times };
})(window);
