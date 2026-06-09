"use client";

import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type PushState =
  | "checking"
  | "unsupported"
  | "needs-install"
  | "ready"
  | "subscribed"
  | "denied"
  | "error";

export default function PushSettings({ vapidPublicKey }: { vapidPublicKey: string }) {
  const [state, setState] = useState<PushState>("checking");
  const [detail, setDetail] = useState<string>("");
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setIsIos(ios);
    const standalone = window.matchMedia("(display-mode: standalone)").matches;

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      // iOS Safari outside the installed PWA has no PushManager — that's the install case
      setState(ios && !standalone ? "needs-install" : "unsupported");
      return;
    }
    if (ios && !standalone) {
      setState("needs-install");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (existing) setState("subscribed");
        else if (Notification.permission === "denied") setState("denied");
        else setState("ready");
      })
      .catch((err) => {
        setState("error");
        setDetail(String(err));
      });
  }, []);

  async function enable() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error(`subscribe endpoint returned ${res.status}`);
      setState("subscribed");
    } catch (err) {
      setState("error");
      setDetail(String(err));
    }
  }

  if (!vapidPublicKey) {
    return <p style={{ color: "crimson" }}>VAPID keys not configured (NEXT_PUBLIC_VAPID_PUBLIC_KEY).</p>;
  }

  switch (state) {
    case "checking":
      return <p>Checking push support…</p>;
    case "needs-install":
      return (
        <div>
          <p>
            <strong>Install Mission Control first.</strong> iOS only delivers web push to
            home-screen-installed apps:
          </p>
          <ol>
            <li>Open this page in Safari</li>
            <li>
              Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>
            </li>
            <li>Open the installed app and come back to Settings</li>
          </ol>
        </div>
      );
    case "unsupported":
      return <p>This browser doesn’t support web push.</p>;
    case "subscribed":
      return <p>✅ Push enabled on this device. The 7 AM brief will notify you here.</p>;
    case "denied":
      return <p>Notifications are blocked for this site — re-enable them in browser settings.</p>;
    case "error":
      return <p style={{ color: "crimson" }}>Push setup failed: {detail}</p>;
    default:
      return (
        <button onClick={enable}>
          Enable push notifications{isIos ? " on this iPhone" : ""}
        </button>
      );
  }
}
