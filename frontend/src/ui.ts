type View = "landing" | "call" | "ended" | "full";
type Side = "local" | "remote";
type QualityState = "reconnecting" | "fair" | "poor" | "good";

const THEME = { light: "#f4f3ee", dark: "#0d0e0e" };
const METER_MS = 120;
const SPEAK_LEVEL = 0.02;
const SPEAK_HOLD_MS = 350;
const FRAME_STALE_MS = 2000;
const COPY_RESET_MS = 1600;
const PERM_ASK = "Meet needs your microphone to talk. Your camera stays off until you turn it on.";
const PERM_HINT =
  "Access is blocked. Allow camera and microphone in your browser's site settings (the icon next to the address bar), then try again.";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const views: Record<View, HTMLElement> = {
  landing: $("view-landing"),
  call: $("view-call"),
  ended: $("view-ended"),
  full: $("view-full"),
};

export function showView(view: View): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", view === "call" ? THEME.dark : THEME.light);
  renderPermission();
}

const perm = { blocked: false, denied: false, tries: 0, open: false };
let micAvailable = false;

function renderPermission(): void {
  const dlg = $<HTMLDialogElement>("perm-dialog");
  const hint = perm.denied || perm.tries > 0;
  $("perm-msg").textContent = hint ? PERM_HINT : PERM_ASK;
  $("btn-perm-allow").textContent = hint ? "Try again" : "Allow access";
  const show = perm.blocked && perm.open && !views.call.hidden;
  if (show && !dlg.open) {
    dlg.showModal();
    $("btn-perm-allow").focus();
  } else if (!show && dlg.open) dlg.close();
}

function syncMic(): void {
  const btn = $<HTMLButtonElement>("btn-toggle-mic");
  const muted = btn.getAttribute("aria-pressed") === "true";
  btn.disabled = !micAvailable && !perm.blocked;
  btn.setAttribute(
    "aria-label",
    micAvailable ? (muted ? "Unmute microphone" : "Mute microphone") : perm.blocked ? "Allow microphone access" : "No microphone available",
  );
  eachTile("local", (el) => el.toggleAttribute("data-muted", !micAvailable || muted));
}

/** Camera or mic access was refused: open the centered dialog once per new block. */
export function setPermission(blocked: boolean, denied: boolean): void {
  if (blocked && !perm.blocked) perm.open = true;
  if (!blocked) perm.tries = 0;
  perm.blocked = blocked;
  perm.denied = denied;
  renderPermission();
  syncMic();
}

function openPermission(): boolean {
  if (perm.blocked) {
    perm.open = true;
    renderPermission();
  }
  return perm.blocked;
}

export function bindPermissionDialog(onAllow: () => Promise<void>): void {
  const dlg = $<HTMLDialogElement>("perm-dialog");
  const allow = $<HTMLButtonElement>("btn-perm-allow");
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    perm.tries++;
    await onAllow().catch(() => undefined);
    allow.disabled = false;
    renderPermission();
  });
  $("btn-perm-skip").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => {
    perm.open = false;
  });
}

/** Alone in the room: show the share link in place of the partner tile. */
export function setAlone(alone: boolean): void {
  $("waiting-panel").hidden = !alone;
  $("remote-tile").hidden = alone;
  $("call-timer").hidden = alone;
}

type Os = "mac" | "windows";
const APPS: Record<Os, { file: string; name: string }> = {
  mac: { file: "Meet.dmg", name: "Mac" },
  windows: { file: "Meet.exe", name: "Windows" },
};

function desktopOs(): Os | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.userAgent;
  if (/windows/i.test(p)) return "windows";
  return /mac/i.test(p) && nav.maxTouchPoints < 2 ? "mac" : null;
}

/** Shows the desktop app download for the visitor's OS (Mac or Windows only). */
export function bindInstallLink(base: string): void {
  const os = desktopOs();
  if (!os) return;
  const link = $<HTMLAnchorElement>("btn-install");
  link.href = `${base}/${APPS[os].file}`;
  $("install-label").textContent = `Install for ${APPS[os].name}`;
  link.hidden = false;
}

export function setLandingError(message: string | null): void {
  const el = $("landing-error");
  const input = $("input-room-id");
  el.textContent = message ?? "";
  el.hidden = !message;
  input.setAttribute("aria-invalid", String(!!message));
  if (message) input.setAttribute("aria-describedby", "landing-error");
  else input.removeAttribute("aria-describedby");
}

export function setRoomLink(roomId: string): void {
  $("room-link").textContent = `${location.origin}/${roomId}`;
}

export function setCallRoomCode(roomId: string): void {
  $("call-room-code").textContent = roomId;
}

const tileIds: Record<Side, string[]> = { local: ["local-tile"], remote: ["remote-tile"] };
const streams: Record<Side, MediaStream | null> = { local: null, remote: null };
const watched = new WeakSet<MediaStreamTrack>();
const frames = { count: -1, at: 0 };

function eachTile(side: Side, fn: (el: HTMLElement) => void): void {
  for (const id of tileIds[side]) {
    const el = document.getElementById(id);
    if (el) fn(el);
  }
}

function remoteFramesFresh(now: number): boolean {
  const q = $<HTMLVideoElement>("remote-video").getVideoPlaybackQuality?.();
  if (!q) return true;
  if (q.totalVideoFrames !== frames.count) {
    frames.count = q.totalVideoFrames;
    frames.at = now;
  }
  return now - frames.at < FRAME_STALE_MS;
}

function syncVideo(side: Side, now = performance.now()): void {
  const live = !!streams[side]?.getVideoTracks().some((t) => t.readyState === "live" && t.enabled && !t.muted);
  const on = live && (side === "local" || remoteFramesFresh(now)) ? "on" : "off";
  eachTile(side, (el) => {
    if (el.dataset.video !== on) el.dataset.video = on;
  });
}

function watchStream(side: Side, stream: MediaStream): void {
  streams[side] = stream;
  const sync = () => {
    for (const t of stream.getVideoTracks()) {
      if (watched.has(t)) continue;
      watched.add(t);
      for (const ev of ["mute", "unmute", "ended"]) t.addEventListener(ev, () => syncVideo(side));
    }
    syncVideo(side);
  };
  stream.onaddtrack = sync;
  stream.onremovetrack = sync;
  sync();
  startMeters();
}

type Meter = { src: MediaStreamAudioSourceNode | null; an: AnalyserNode | null; id: string; until: number };

const meters: Record<Side, Meter> = {
  local: { src: null, an: null, id: "", until: 0 },
  remote: { src: null, an: null, id: "", until: 0 },
};
const buf = new Float32Array(512);
let ctx: AudioContext | null = null;
let meterTimer: number | null = null;

function audioCtx(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
    addEventListener("pointerdown", () => void ctx?.resume().catch(() => undefined), { passive: true });
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

function rebind(m: Meter, track: MediaStreamTrack | undefined): void {
  m.src?.disconnect();
  m.src = null;
  m.an = null;
  m.id = track?.id ?? "";
  const c = track ? audioCtx() : null;
  if (!c || !track) return;
  try {
    const an = c.createAnalyser();
    an.fftSize = buf.length;
    const src = c.createMediaStreamSource(new MediaStream([track]));
    src.connect(an);
    m.src = src;
    m.an = an;
  } catch {
    m.src = null;
    m.an = null;
  }
}

function rms(an: AnalyserNode): number {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function meterTick(): void {
  const now = performance.now();
  for (const side of ["local", "remote"] as const) {
    const m = meters[side];
    const track = streams[side]?.getAudioTracks().find((t) => t.readyState === "live");
    if ((track?.id ?? "") !== m.id) rebind(m, track);
    if (m.an && track?.enabled && rms(m.an) > SPEAK_LEVEL) m.until = now + SPEAK_HOLD_MS;
    const speaking = now < m.until;
    eachTile(side, (el) => el.toggleAttribute("data-speaking", speaking));
  }
  syncVideo("remote", now);
}

function startMeters(): void {
  meterTimer ??= window.setInterval(meterTick, METER_MS);
}

export function setLocalVideoStream(stream: MediaStream): void {
  $<HTMLVideoElement>("local-video").srcObject = stream;
  watchStream("local", stream);
}

const UNLOCK_EVENTS = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

/** Points a media element at exactly `tracks`; false when it already plays them. */
function attachTracks(el: HTMLMediaElement, tracks: MediaStreamTrack[]): boolean {
  const cur = el.srcObject;
  if (cur instanceof MediaStream && cur.getTracks().length === tracks.length && tracks.every((t) => cur.getTrackById(t.id))) {
    return false;
  }
  el.srcObject = tracks.length ? new MediaStream(tracks) : null;
  return true;
}

const unlockRemoteAudio = (): void => {
  for (const e of UNLOCK_EVENTS) removeEventListener(e, unlockRemoteAudio, true);
  playRemoteAudio();
};

/**
 * Browsers block autoplay-with-sound on a page with no user gesture yet (for
 * example someone who opened a shared link). On a block, show the hint and
 * retry on the first interaction.
 */
function playRemoteAudio(): void {
  const el = $<HTMLAudioElement>("remote-audio");
  const hint = $<HTMLButtonElement>("btn-unmute-remote");
  const src = el.srcObject;
  if (!src) return;
  el.play().then(
    () => {
      if (el.srcObject === src) hint.hidden = true;
    },
    (err: unknown) => {
      if (el.srcObject !== src || !(err instanceof DOMException) || err.name !== "NotAllowedError") return;
      hint.hidden = false;
      for (const e of UNLOCK_EVENTS) addEventListener(e, unlockRemoteAudio, true);
    },
  );
}

/**
 * Remote audio plays from its own <audio> element. A <video> element whose
 * stream holds a video track with no frames yet (partner camera off) never
 * leaves HAVE_NOTHING in Chrome/Safari, so audio in the same element stays
 * silent until the first video frame. The video element stays muted.
 */
export function setRemoteVideoStream(stream: MediaStream): void {
  const video = $<HTMLVideoElement>("remote-video");
  video.muted = true;
  if (attachTracks(video, stream.getVideoTracks())) {
    frames.count = -1;
    void video.play().catch(() => undefined);
  }
  if (attachTracks($<HTMLAudioElement>("remote-audio"), stream.getAudioTracks())) playRemoteAudio();
  watchStream("remote", stream);
}

export function bindCameraToggle(onToggle: (enable: boolean) => Promise<boolean>): void {
  const btn = $<HTMLButtonElement>("btn-toggle-camera");
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", async () => {
    const enable = btn.getAttribute("aria-pressed") !== "true";
    btn.disabled = true;
    const on = await onToggle(enable).catch(() => false);
    btn.disabled = false;
    if (enable && !on && !openPermission()) btn.title = "Camera unavailable — check browser permissions";
  });
}

/** Reflects which local devices are on (calls start audio-only; both are optional). */
export function setLocalMediaState(audio: boolean, video: boolean): void {
  const cam = $<HTMLButtonElement>("btn-toggle-camera");
  cam.setAttribute("aria-pressed", String(video));
  cam.setAttribute("aria-label", video ? "Turn camera off" : "Turn camera on");
  if (video) cam.removeAttribute("title");
  $("icon-camera-on").classList.toggle("hidden", !video);
  $("icon-camera-off").classList.toggle("hidden", video);
  micAvailable = audio;
  syncMic();
}

export function setEndedMessage(title: string, message: string): void {
  $("ended-title").textContent = title;
  $("ended-message").textContent = message;
}

let durationTimer: number | null = null;

export function startCallDurationTimer(): void {
  stopCallDurationTimer();
  const startedAt = Date.now();
  const el = $("call-duration");
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    el.textContent = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
  const btn = $<HTMLButtonElement>("btn-toggle-mic");
  const onIcon = $("icon-mic-on");
  const offIcon = $("icon-mic-off");
  let enabled = true;
  btn.addEventListener("click", () => {
    if (!micAvailable) {
      openPermission();
      return;
    }
    enabled = !enabled;
    btn.setAttribute("aria-pressed", String(!enabled));
    btn.setAttribute("aria-label", enabled ? "Mute microphone" : "Unmute microphone");
    onIcon.classList.toggle("hidden", !enabled);
    offIcon.classList.toggle("hidden", enabled);
    eachTile("local", (el) => el.toggleAttribute("data-muted", !enabled));
    onToggle(enabled);
  });
}

export function bindEndCall(onEnd: () => void): void {
  $("btn-end-call").addEventListener("click", onEnd);
}

export function bindStartNewFromFull(onStart: () => void): void {
  $("btn-new-from-full").addEventListener("click", onStart);
}

export function bindCopyLink(): void {
  const btn = $("btn-copy-link");
  const label = $("copy-label");
  let reset: number | null = null;
  btn.addEventListener("click", async () => {
    const link = $("room-link");
    try {
      await navigator.clipboard.writeText(link.textContent ?? "");
      label.textContent = "Copied";
      if (reset !== null) window.clearTimeout(reset);
      reset = window.setTimeout(() => (label.textContent = "Copy"), COPY_RESET_MS);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(link);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  });
}

const QUALITY_DOT: Record<QualityState, string> = {
  reconnecting: "bg-warn",
  fair: "bg-warn",
  poor: "bg-danger",
  good: "bg-accent",
};

function formatKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

function showQuality(level: QualityState, text: string): void {
  $("quality-indicator").hidden = false;
  $("quality-dot").className = `dot ${QUALITY_DOT[level]}`;
  $("quality-label").textContent = text;
}

export function setReconnectingIndicator(): void {
  showQuality("reconnecting", "Reconnecting…");
}

export function setNetworkIndicator(level: QualityState, downloadKbps: number | null, uploadKbps: number | null): void {
  if (downloadKbps === null && uploadKbps === null) {
    showQuality(level, "Measuring…");
    return;
  }
  const down = downloadKbps !== null ? formatKbps(downloadKbps) : "–";
  const up = uploadKbps !== null ? formatKbps(uploadKbps) : "–";
  showQuality(level, `↓${down} ↑${up}`);
}

export function hideNetworkIndicator(): void {
  $("quality-indicator").hidden = true;
}

export function setPeerStatusBadge(width: number, height: number, transport: "direct" | "relay" | null): void {
  $("peer-status-badge").textContent = `${width}×${height} · ${transport ?? "…"}`;
}

export function bindShareToggle(onToggle: () => void): void {
  const btn = $<HTMLButtonElement>("btn-toggle-share");
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", onToggle);
}

export function setShareButtonState(sharing: boolean): void {
  const btn = $<HTMLButtonElement>("btn-toggle-share");
  btn.setAttribute("aria-pressed", String(sharing));
  btn.setAttribute("aria-label", sharing ? "Stop sharing your screen" : "Share your screen");
  $("local-tile").toggleAttribute("data-sharing", sharing);
}

export function bindPipToggle(onToggle: () => void): void {
  const btn = $<HTMLButtonElement>("btn-toggle-pip");
  btn.hidden = false;
  btn.addEventListener("click", onToggle);
}

export function setPipButtonState(active: boolean): void {
  $<HTMLButtonElement>("btn-toggle-pip").setAttribute("aria-pressed", String(active));
}

export function bindDevicePicker(onOpen: () => void): { close: () => void } {
  const btn = $<HTMLButtonElement>("btn-toggle-devices");
  const panel = $("device-picker");

  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };

  btn.addEventListener("click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    onOpen();
  });

  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!panel.hidden && !panel.contains(t) && !btn.contains(t)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || panel.hidden) return;
    close();
    btn.focus();
  });

  return { close };
}

export function populateDeviceSelects(
  cameras: { deviceId: string; label: string }[],
  microphones: { deviceId: string; label: string }[],
  onCameraChange: (deviceId: string) => void,
  onMicChange: (deviceId: string) => void,
): void {
  const cameraSelect = $<HTMLSelectElement>("select-camera");
  const micSelect = $<HTMLSelectElement>("select-microphone");

  cameraSelect.replaceChildren(...cameras.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  micSelect.replaceChildren(...microphones.map((d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  cameraSelect.disabled = !cameras.length;
  micSelect.disabled = !microphones.length;

  cameraSelect.onchange = () => onCameraChange(cameraSelect.value);
  micSelect.onchange = () => onMicChange(micSelect.value);
}
