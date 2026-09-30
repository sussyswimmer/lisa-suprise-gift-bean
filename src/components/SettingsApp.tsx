import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { version as packageVersion } from "../../package.json";
import BeanMark from "./BeanMark";
import BeanSprite from "./BeanSprite";
import {
  ACTIVITY_LABELS,
  ActivityFrequency,
  SHEET_ACTIVITIES,
  TOGGLEABLE_ACTIVITIES,
  availableActivities,
  motionFor,
} from "../activity";
import { DEFAULT_ASSET_PACK, loadManifest } from "../beanAssets";
import { isBeanDesktop, playTone } from "../platform";
import {
  BeanPrefs,
  BeanSize,
  defaultPreferences,
  sanitizePrefs,
  SETTINGS_KEYS,
  SettingsPatch,
} from "../state";
import { BeanStatus, onMessageFromBean, sendToBean } from "../settingsBus";
import { BeanAsset, BeanManifest, IdleActivity } from "../types";

const PREFS_KEY = "bean.preferences.v1";

type Section =
  "general" | "animations" | "appearance" | "notifications" | "about";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "general", label: "General", hint: "Monitoring and privacy" },
  { id: "animations", label: "Animations", hint: "What Bean gets up to" },
  { id: "appearance", label: "Appearance", hint: "Size and window" },
  { id: "notifications", label: "Notifications", hint: "Sounds and reactions" },
  { id: "about", label: "About & reset", hint: "Version and repairs" },
];

const ACTIVITY_NOTES: Partial<Record<IdleActivity, string>> = {
  zoomies: "Runs back and forth",
  patrol: "Trots around the window",
  peek: "Leans out to look around",
  hop: "A quick little hop",
};

function savedPrefs(): BeanPrefs {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(PREFS_KEY) ?? "null",
    );
    if (saved && typeof saved === "object" && "preferences" in saved)
      return sanitizePrefs(saved.preferences, defaultPreferences);
  } catch {
    /* Fall back to defaults until Bean's window reports in. */
  }
  return { ...defaultPreferences };
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`sw${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function Row({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="st-row">
      <div className="st-row-text">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="st-card">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** The art Settings shows for an activity: its own sheet, or what it borrows. */
function previewFor(activity: IdleActivity, manifest: BeanManifest): BeanAsset {
  const motion = motionFor(activity);
  return (
    manifest.activities?.[activity] ??
    (motion && manifest.motions?.[motion]) ??
    manifest.states.idle
  );
}

export default function SettingsApp() {
  const [prefs, setPrefs] = useState<BeanPrefs>(savedPrefs);
  const [status, setStatus] = useState<BeanStatus | null>(null);
  const [section, setSection] = useState<Section>("general");
  const [manifest, setManifest] = useState<BeanManifest>(DEFAULT_ASSET_PACK);
  const [version, setVersion] = useState(packageVersion);
  const [notice, setNotice] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const desktop = isBeanDesktop();

  useEffect(() => {
    document.title = "Bean Settings";
    const stop = onMessageFromBean((message) => {
      setPrefs(message.prefs);
      setStatus(message.status);
    });
    sendToBean({ type: "hello" });
    void loadManifest().then(setManifest);
    if (desktop)
      void getVersion()
        .then(setVersion)
        .catch(() => undefined);
    return stop;
  }, [desktop]);

  const update = (patch: SettingsPatch) => {
    setPrefs((current) => ({ ...current, ...patch }));
    sendToBean({ type: "patch", patch });
  };

  const available = useMemo(
    () => availableActivities(manifest.activities),
    [manifest],
  );
  // Sheet-only activities appear once the asset pack provides their art.
  const shownActivities = TOGGLEABLE_ACTIVITIES.filter(
    (activity) =>
      !SHEET_ACTIVITIES.includes(activity) || available.has(activity),
  );
  const disabled = new Set(prefs.disabledActivities);
  const setActivity = (activity: IdleActivity, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(activity);
    else next.add(activity);
    update({ disabledActivities: [...next] });
  };

  const run = async (label: string, action: () => Promise<string | void>) => {
    if (!desktop) {
      setNotice(`${label} is available in the Bean desktop app.`);
      return;
    }
    setNotice("");
    try {
      setNotice((await action()) || `${label}: done.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  // Connection checks run in Bean's window so she reconnects straight away;
  // their result arrives as Bean's notice.
  const askBean = (message: "checkAccess" | "resetPermission") => {
    setNotice("");
    sendToBean({ type: message });
  };
  const checking = status?.checkingAccess ?? false;

  const monitorLabel = !status
    ? "Connecting to Bean…"
    : status.unavailable
      ? "Waiting for Claude"
      : prefs.paused
        ? "Paused"
        : "Watching Claude";
  const monitorTone = !status
    ? "is-muted"
    : status.unavailable
      ? "is-warning"
      : prefs.paused
        ? "is-muted"
        : "";

  return (
    <div className="st-shell">
      <nav className="st-nav" aria-label="Settings sections">
        <div className="st-brand">
          <BeanMark size={30} />
          <div>
            <strong>Bean</strong>
            <span>Settings</span>
          </div>
        </div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`st-nav-item${section === item.id ? " is-active" : ""}`}
            aria-current={section === item.id ? "page" : undefined}
            onClick={() => setSection(item.id)}
          >
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </button>
        ))}
        <div className={`st-presence ${monitorTone}`}>
          <i aria-hidden="true" />
          {monitorLabel}
        </div>
      </nav>

      <main className="st-main">
        {section === "general" && (
          <>
            <header className="st-head">
              <h1>General</h1>
              <p>Choose when Bean watches Claude and what she may show.</p>
            </header>
            <Card>
              <div className={`st-status ${monitorTone}`}>
                <i aria-hidden="true" />
                <div>
                  <strong>{monitorLabel}</strong>
                  <span>
                    {status?.notice ||
                      status?.statusText ||
                      "Open Bean to change settings."}
                  </span>
                </div>
              </div>
              <Row
                title="Monitor Claude"
                detail="Bean reacts when Claude starts, finishes, or needs you."
              >
                <Switch
                  label="Monitor Claude"
                  checked={!prefs.paused}
                  onChange={(on) => update({ paused: !on })}
                />
              </Row>
              <Row
                title="Claude Code previews"
                detail="Allow short snippets of Claude Code's work in Bean's speech bubble."
              >
                <Switch
                  label="Claude Code previews"
                  checked={prefs.showContent}
                  onChange={(on) => update({ showContent: on })}
                />
              </Row>
            </Card>
          </>
        )}

        {section === "animations" && (
          <>
            <header className="st-head">
              <h1>Animations</h1>
              <p>
                While Claude is quiet, Bean rests, then picks one of these at
                random.
              </p>
            </header>
            <Card title="How often">
              <Segmented<ActivityFrequency>
                label="How often Bean does something"
                value={prefs.activityFrequency}
                onChange={(value) => update({ activityFrequency: value })}
                options={[
                  { value: "calm", label: "Calm" },
                  { value: "normal", label: "Normal" },
                  { value: "lively", label: "Lively" },
                ]}
              />
              <p className="st-help">
                {prefs.activityFrequency === "calm"
                  ? "Something every 15–20 seconds."
                  : prefs.activityFrequency === "lively"
                    ? "Something every few seconds."
                    : "Something every 7–11 seconds."}
              </p>
            </Card>
            <Card title="Activities">
              <div className="st-bulk">
                <span>
                  {shownActivities.filter((a) => !disabled.has(a)).length} of{" "}
                  {shownActivities.length} on
                </span>
                <button
                  type="button"
                  className="st-link"
                  onClick={() => update({ disabledActivities: [] })}
                >
                  Turn all on
                </button>
                <button
                  type="button"
                  className="st-link"
                  onClick={() =>
                    update({ disabledActivities: [...shownActivities] })
                  }
                >
                  Turn all off
                </button>
              </div>
              <ul className="st-activities">
                {shownActivities.map((activity) => {
                  const on = !disabled.has(activity);
                  return (
                    <li
                      key={activity}
                      className={`st-activity${on ? "" : " is-off"}`}
                    >
                      <div
                        className="st-activity-art"
                        aria-hidden="true"
                        style={previewScale(previewFor(activity, manifest))}
                      >
                        <BeanSprite
                          asset={previewFor(activity, manifest)}
                          className="st-activity-sprite"
                        />
                      </div>
                      <div className="st-activity-text">
                        <strong>{capitalize(ACTIVITY_LABELS[activity])}</strong>
                        {ACTIVITY_NOTES[activity] && (
                          <small>{ACTIVITY_NOTES[activity]}</small>
                        )}
                      </div>
                      <Switch
                        label={capitalize(ACTIVITY_LABELS[activity])}
                        checked={on}
                        onChange={(value) => setActivity(activity, value)}
                      />
                    </li>
                  );
                })}
              </ul>
            </Card>
          </>
        )}

        {section === "appearance" && (
          <>
            <header className="st-head">
              <h1>Appearance</h1>
              <p>How big Bean is and how her window behaves.</p>
            </header>
            <Card>
              <Row title="Bean's size" detail="Her window grows to fit.">
                <Segmented<BeanSize>
                  label="Bean's size"
                  value={prefs.beanSize}
                  onChange={(value) => update({ beanSize: value })}
                  options={[
                    { value: "small", label: "Small" },
                    { value: "medium", label: "Medium" },
                    { value: "large", label: "Large" },
                  ]}
                />
              </Row>
              <Row
                title="Keep Bean on top"
                detail="Float above other windows so she is always visible."
              >
                <Switch
                  label="Keep Bean on top"
                  checked={prefs.alwaysOnTop}
                  onChange={(on) => update({ alwaysOnTop: on })}
                />
              </Row>
              <Row
                title="Speech bubble"
                detail="Show what Bean is doing above her head."
              >
                <Switch
                  label="Speech bubble"
                  checked={prefs.showBubble}
                  onChange={(on) => update({ showBubble: on })}
                />
              </Row>
            </Card>
          </>
        )}

        {section === "notifications" && (
          <>
            <header className="st-head">
              <h1>Notifications</h1>
              <p>Which Claude moments Bean reacts to, and how.</p>
            </header>
            <Card title="Sound">
              <Row
                title="Completion sound"
                detail="Play a gentle chime when Claude finishes."
              >
                <Switch
                  label="Completion sound"
                  checked={prefs.soundEnabled}
                  onChange={(on) => update({ soundEnabled: on })}
                />
              </Row>
              <Row title="Volume" detail={`${prefs.soundVolume}%`}>
                <div className="st-volume">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={prefs.soundVolume}
                    disabled={!prefs.soundEnabled}
                    aria-label="Chime volume"
                    onChange={(event) =>
                      update({ soundVolume: Number(event.target.value) })
                    }
                  />
                  <button
                    type="button"
                    className="st-button"
                    disabled={!prefs.soundEnabled}
                    onClick={() => playTone(prefs.soundVolume)}
                  >
                    Test
                  </button>
                </div>
              </Row>
            </Card>
            <Card title="Reactions">
              <Row
                title="Celebrate finished replies"
                detail="Bean does a happy jump when Claude is done."
              >
                <Switch
                  label="Celebrate finished replies"
                  checked={prefs.celebrateCompletions}
                  onChange={(on) => update({ celebrateCompletions: on })}
                />
              </Row>
              <Row
                title="Alert when Claude needs you"
                detail="Bean perks up and shows ! when Claude is waiting on you."
              >
                <Switch
                  label="Alert when Claude needs you"
                  checked={prefs.alertOnAttention}
                  onChange={(on) => update({ alertOnAttention: on })}
                />
              </Row>
            </Card>
          </>
        )}

        {section === "about" && (
          <>
            <header className="st-head">
              <h1>About & reset</h1>
              <p>Version details, connection repairs, and a fresh start.</p>
            </header>
            <Card>
              <div className="st-about">
                <BeanMark size={44} />
                <div>
                  <strong>Bean</strong>
                  <span>Version {version}</span>
                  <span>
                    A floating companion that watches Claude with you.
                  </span>
                </div>
              </div>
            </Card>
            <Card title="Connection">
              <Row
                title="Check Claude connection"
                detail="Re-checks Accessibility access and whether Claude is readable."
              >
                <button
                  type="button"
                  className="st-button"
                  disabled={checking}
                  onClick={() => askBean("checkAccess")}
                >
                  {checking ? "Checking…" : "Check"}
                </button>
              </Row>
              {status?.permissionDenied && (
                <Row
                  title="Reset permission"
                  detail="Bean is switched on in Accessibility but still blocked? This clears Bean's old permission so you can allow her again."
                >
                  <button
                    type="button"
                    className="st-button"
                    disabled={checking}
                    onClick={() => askBean("resetPermission")}
                  >
                    Reset permission
                  </button>
                </Row>
              )}
              {status?.notice && (
                <p className="st-help" role="status">
                  {status.notice}
                </p>
              )}
              <Row
                title="Accessibility settings"
                detail="Open macOS Privacy & Security → Accessibility."
              >
                <button
                  type="button"
                  className="st-button"
                  onClick={() =>
                    void run("Opening Accessibility settings", () =>
                      invoke("open_accessibility_settings"),
                    )
                  }
                >
                  Open
                </button>
              </Row>
            </Card>
            <Card title="Reset">
              <Row
                title="Reset Bean's position"
                detail="Move Bean back to the middle of the screen."
              >
                <button
                  type="button"
                  className="st-button"
                  onClick={() =>
                    void run("Resetting Bean's position", async () => {
                      await invoke("reset_window_position");
                      return "Bean is back in the middle of the screen.";
                    })
                  }
                >
                  Reset position
                </button>
              </Row>
              <Row
                title="Reset all settings"
                detail="Every setting on these pages goes back to its default."
              >
                {confirmReset ? (
                  <div className="st-confirm">
                    <button
                      type="button"
                      className="st-button is-danger"
                      onClick={() => {
                        sendToBean({ type: "reset" });
                        setPrefs((current) => ({
                          ...current,
                          ...Object.fromEntries(
                            SETTINGS_KEYS.map((key) => [
                              key,
                              defaultPreferences[key],
                            ]),
                          ),
                        }));
                        setConfirmReset(false);
                        setNotice("Settings are back to their defaults.");
                      }}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      className="st-button"
                      onClick={() => setConfirmReset(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="st-button"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset settings…
                  </button>
                )}
              </Row>
              <Row title="Quit Bean" detail="Close Bean and her menu bar icon.">
                <button
                  type="button"
                  className="st-button is-danger"
                  onClick={() => void run("Quitting", () => invoke("quit_app"))}
                >
                  Quit
                </button>
              </Row>
            </Card>
          </>
        )}

        {notice && (
          <p className="st-notice" role="status">
            {notice}
          </p>
        )}
      </main>
    </div>
  );
}

/** Sheets drawn small (to leave room for a ball or a jump) are enlarged a bit. */
function previewScale(asset: BeanAsset): CSSProperties {
  const scale =
    typeof asset === "string" ? 1 : Math.min(asset.scale ?? 1, 1.35);
  return { "--preview-scale": scale } as CSSProperties;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
