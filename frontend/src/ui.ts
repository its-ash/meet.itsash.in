type View = "landing" | "waiting" | "call" | "ended";

const views: Record<View, HTMLElement> = {
  landing: document.getElementById("view-landing") as HTMLElement,
  waiting: document.getElementById("view-waiting") as HTMLElement,
  call: document.getElementById("view-call") as HTMLElement,
  ended: document.getElementById("view-ended") as HTMLElement,
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

export function setWaitingCountdown(seconds: number): void {
  (document.getElementById("waiting-countdown") as HTMLElement).textContent = String(seconds);
}

export function setLocalPreview(stream: MediaStream): void {
  const preview = document.getElementById("local-preview") as HTMLVideoElement;
  preview.srcObject = stream;
}

export function setCallRoomCode(roomId: string): void {
  (document.getElementById("call-room-code") as HTMLElement).textContent = roomId;
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

export function bindMicToggle(onToggle: (enabled: boolean) => void): void {
  const btn = document.getElementById("btn-toggle-mic") as HTMLButtonElement;
  let enabled = true;
  btn.addEventListener("click", () => {
    enabled = !enabled;
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.setAttribute("aria-label", enabled ? "Mute microphone" : "Unmute microphone");
    onToggle(enabled);
  });
}

export function bindCameraToggle(onToggle: (enabled: boolean) => void): void {
  const btn = document.getElementById("btn-toggle-camera") as HTMLButtonElement;
  let enabled = true;
  btn.addEventListener("click", () => {
    enabled = !enabled;
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.setAttribute("aria-label", enabled ? "Turn off camera" : "Turn on camera");
    onToggle(enabled);
  });
}

export function bindEndCall(onEnd: () => void): void {
  document.getElementById("btn-end-call")?.addEventListener("click", onEnd);
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
