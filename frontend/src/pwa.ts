interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isStandalone = (): boolean =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

export function bindInstallButton(): void {
  const btn = document.getElementById("btn-install") as HTMLButtonElement | null;
  const hint = document.getElementById("install-hint");
  if (!btn || isStandalone()) return;

  let deferred: InstallPromptEvent | null = null;
  const hide = () => {
    btn.hidden = true;
    if (hint) hint.hidden = true;
  };

  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    btn.hidden = false;
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    hide();
  });

  if (isIos()) btn.hidden = false;

  btn.addEventListener("click", async () => {
    if (deferred) {
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === "accepted" || !isIos()) hide();
      return;
    }
    if (hint) hint.hidden = !hint.hidden;
  });
}
