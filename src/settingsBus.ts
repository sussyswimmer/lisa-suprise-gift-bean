import { emit, listen } from "@tauri-apps/api/event";
import { isBeanDesktop } from "./platform";
import { BeanPrefs, SettingsPatch } from "./state";

/**
 * Messages between Bean's window and the Settings window. Bean's window owns
 * the preferences and is the only one that saves them; Settings asks it to
 * change them and shows what it reports back.
 */
export type ToBean =
  | { type: "hello" }
  | { type: "patch"; patch: SettingsPatch }
  | { type: "reset" };

export interface BeanStatus {
  paused: boolean;
  unavailable: boolean;
  statusText: string;
}

export type FromBean = {
  type: "prefs";
  prefs: BeanPrefs;
  status: BeanStatus;
};

const TO_BEAN = "bean-settings-to-main";
const FROM_BEAN = "bean-settings-from-main";

type Unlisten = () => void;

// Outside the desktop app (a browser preview or tests) two tabs talk over a
// BroadcastChannel instead of Tauri events.
function channel(name: string) {
  return typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(name);
}

function send(name: string, message: unknown) {
  if (isBeanDesktop()) {
    void emit(name, message).catch(() => undefined);
    return;
  }
  const bc = channel(name);
  bc?.postMessage(message);
  bc?.close();
}

function subscribe<T>(name: string, handler: (message: T) => void): Unlisten {
  if (isBeanDesktop()) {
    let active = true;
    let remove: Unlisten | undefined;
    void listen<T>(name, (event) => {
      if (active) handler(event.payload);
    })
      .then((unlisten) => {
        if (active) remove = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      remove?.();
    };
  }
  const bc = channel(name);
  if (!bc) return () => undefined;
  bc.onmessage = (event: MessageEvent<T>) => handler(event.data);
  return () => bc.close();
}

export const sendToBean = (message: ToBean) => send(TO_BEAN, message);
export const sendFromBean = (message: FromBean) => send(FROM_BEAN, message);
export const onMessageToBean = (handler: (message: ToBean) => void) =>
  subscribe(TO_BEAN, handler);
export const onMessageFromBean = (handler: (message: FromBean) => void) =>
  subscribe(FROM_BEAN, handler);
