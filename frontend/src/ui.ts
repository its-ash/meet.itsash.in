type View = "landing" | "waiting" | "call" | "ended" | "full";

const views: Record<View, HTMLElement> = {
  landing: document.getElementById("view-landing") as HTMLElement,
  waiting: document.getElementById("view-waiting") as HTMLElement,
  call: document.getElementById("view-call") as HTMLElement,
  ended: document.getElementById("view-ended") as HTMLElement,
  full: document.getElementById("view-full") as HTMLElement,
};

export function showView(view: View): void {
  for (const [name, el] of Object.entries(views)) {
    el.classList.toggle("hidden", name !== view);
  }
}

export function setLandingError(message: string | null): void {
  const el = document.getElementById("landing-error") as HTMLElement;
  if (message) {
    el.textContent = message;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

export function setRoomLink(roomId: string): void {
  const link = `${location.origin}/${roomId}`;
  (document.getElementById("room-link") as HTMLElement).textContent = link;
}

export function setLocalPreview(stream: MediaStream): void {
  const preview = document.getElementById("local-preview") as HTMLVideoElement;
  preview.srcObject = stream;
}

export function setCallRoomCode(roomId: string): void {
  (document.getElementById("call-room-code") as HTMLElement).textContent = roomId;
  const waitingLabel = document.getElementById("call-room-code-waiting");
  if (waitingLabel) waitingLabel.textContent = roomId;
}

export function setLocalVideoStream(stream: MediaStream): void {
  (document.getElementById("local-video") as HTMLVideoElement).srcObject = stream;
}

export function setRemoteVideoStream(stream: MediaStream): void {
  (document.getElementById("remote-video") as HTMLVideoElement).srcObject = stream;
}

export function setEndedMessage(title: string, message: string): void {
  (document.getElementById("ended-title") as HTMLElement).textContent = title;
  (document.getElementById("ended-message") as HTMLElement).textContent = message;
}

let durationTimer: number | null = null;
export function startCallDurationTimer(): void {
  const startedAt = Date.now();
  const el = document.getElementById("call-duration") as HTMLElement;
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    el.textContent = `${mm}:${ss}`;
  };
  tick();
  durationTimer = window.setInterval(tick, 1000);
}

export function stopCallDurationTimer(): void {
  if (durationTimer !== null) {
    window.clearInterval(durationTimer);
    durationTimer = null;
  }
}

function setToggleVisualState(
  btn: HTMLButtonElement,
  onIcon: HTMLElement,
  offIcon: HTMLElement,
  active: boolean,
): void {
  onIcon.classList.toggle("hidden", active);
  offIcon.classList.toggle("hidden", !active);
  btn.classList.toggle("border-danger", active);
  btn.classList.toggle("text-danger", active);
  btn.classList.toggle("border-white/15", !active);
  btn.classList.toggle("text-white", !active);
}

export function bindMicToggle(onToggle: (enabled: boolean) => void): void {
  const btn = document.getElementById("btn-toggle-mic") as HTMLButtonElement;
  const onIcon = document.getElementById("icon-mic-on") as HTMLElement;
  const offIcon = document.getElementById("icon-mic-off") as HTMLElement;
  let enabled = true;
  btn.addEventListener("click", () => {
    enabled = !enabled;
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.setAttribute("aria-label", enabled ? "Mute microphone" : "Unmute microphone");
    setToggleVisualState(btn, onIcon, offIcon, !enabled);
    onToggle(enabled);
  });
}

export function bindCameraToggle(onToggle: (enabled: boolean) => void): void {
  const btn = document.getElementById("btn-toggle-camera") as HTMLButtonElement;
  const onIcon = document.getElementById("icon-camera-on") as HTMLElement;
  const offIcon = document.getElementById("icon-camera-off") as HTMLElement;
  let enabled = true;
  btn.addEventListener("click", () => {
    enabled = !enabled;
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.setAttribute("aria-label", enabled ? "Turn off camera" : "Turn on camera");
    setToggleVisualState(btn, onIcon, offIcon, !enabled);
    onToggle(enabled);
  });
}

export function bindEndCall(onEnd: () => void): void {
  document.getElementById("btn-end-call")?.addEventListener("click", onEnd);
}

export function bindStartNewFromFull(onStart: () => void): void {
  document.getElementById("btn-new-from-full")?.addEventListener("click", onStart);
}

export function bindCopyLink(): void {
  document.getElementById("btn-copy-link")?.addEventListener("click", async () => {
    const text = document.getElementById("room-link")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable — link is still selectable text.
    }
  });
}

type QualityState = "reconnecting" | "fair" | "poor" | "good";

const QUALITY_DOT_CLASS: Record<QualityState, string> = {
  reconnecting: "bg-amber-400",
  fair: "bg-amber-400",
  poor: "bg-danger",
  good: "bg-emerald-400",
};

function formatKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function setReconnectingIndicator(): void {
  const el = document.getElementById("quality-indicator") as HTMLElement;
  const dot = document.getElementById("quality-dot") as HTMLElement;
  const label = document.getElementById("quality-label") as HTMLElement;

  el.classList.remove("hidden");
  el.classList.add("flex");
  dot.className = `w-1.5 h-1.5 rounded-full ${QUALITY_DOT_CLASS.reconnecting}`;
  label.textContent = "Reconnecting…";
}

export function setNetworkIndicator(level: QualityState, downloadKbps: number | null, uploadKbps: number | null): void {
  const el = document.getElementById("quality-indicator") as HTMLElement;
  const dot = document.getElementById("quality-dot") as HTMLElement;
  const label = document.getElementById("quality-label") as HTMLElement;

  el.classList.remove("hidden");
  el.classList.add("flex");
  dot.className = `w-1.5 h-1.5 rounded-full ${QUALITY_DOT_CLASS[level]}`;

  if (downloadKbps === null && uploadKbps === null) {
    label.textContent = "Measuring…";
    return;
  }
  const down = downloadKbps !== null ? formatKbps(downloadKbps) : "–";
  const up = uploadKbps !== null ? formatKbps(uploadKbps) : "–";
  label.textContent = `↓${down} ↑${up}`;
}

export function hideNetworkIndicator(): void {
  const el = document.getElementById("quality-indicator") as HTMLElement;
  el.classList.add("hidden");
  el.classList.remove("flex");
}

export function setPeerStatusBadge(width: number, height: number, transport: "direct" | "relay" | null): void {
  const el = document.getElementById("peer-status-badge") as HTMLElement;
  const transportLabel = transport === "relay" ? "relay" : transport === "direct" ? "direct" : "…";
  el.textContent = `${width}×${height} · ${transportLabel}`;
}

export function bindShareToggle(onToggle: () => void): void {
  document.getElementById("btn-toggle-share")?.addEventListener("click", onToggle);
}

export function setShareButtonState(sharing: boolean): void {
  const btn = document.getElementById("btn-toggle-share") as HTMLButtonElement;
  btn.setAttribute("aria-pressed", String(sharing));
  btn.setAttribute("aria-label", sharing ? "Stop sharing your screen" : "Share your screen");
  btn.classList.toggle("border-accent", sharing);
  btn.classList.toggle("text-accent", sharing);
  btn.classList.toggle("border-white/15", !sharing);
  btn.classList.toggle("text-white", !sharing);
}

export function bindPipToggle(onToggle: () => void): void {
  const btn = document.getElementById("btn-toggle-pip") as HTMLButtonElement;
  btn.hidden = false;
  btn.addEventListener("click", onToggle);
}

export function setPipButtonState(active: boolean): void {
  const btn = document.getElementById("btn-toggle-pip") as HTMLButtonElement;
  btn.setAttribute("aria-pressed", String(active));
}

export function bindDevicePicker(onOpen: () => void): { close: () => void } {
  const btn = document.getElementById("btn-toggle-devices") as HTMLButtonElement;
  const panel = document.getElementById("device-picker") as HTMLElement;

  const close = () => {
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.addEventListener("click", () => {
    const isOpen = !panel.classList.contains("hidden");
    if (isOpen) {
      close();
    } else {
      panel.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      onOpen();
    }
  });

  document.addEventListener("click", (event) => {
    if (!panel.classList.contains("hidden") && !panel.contains(event.target as Node) && event.target !== btn) {
      close();
    }
  });

  return { close };
}

export function populateDeviceSelects(
  cameras: { deviceId: string; label: string }[],
  microphones: { deviceId: string; label: string }[],
  onCameraChange: (deviceId: string) => void,
  onMicChange: (deviceId: string) => void,
): void {
  const cameraSelect = document.getElementById("select-camera") as HTMLSelectElement;
  const micSelect = document.getElementById("select-microphone") as HTMLSelectElement;

  cameraSelect.innerHTML = cameras
    .map((d) => `<option value="${d.deviceId}">${d.label}</option>`)
    .join("");
  micSelect.innerHTML = microphones
    .map((d) => `<option value="${d.deviceId}">${d.label}</option>`)
    .join("");

  cameraSelect.onchange = () => onCameraChange(cameraSelect.value);
  micSelect.onchange = () => onMicChange(micSelect.value);
}
