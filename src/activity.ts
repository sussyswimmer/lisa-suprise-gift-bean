import {
  ActivityArt,
  BeanAsset,
  BeanMotion,
  BeanState,
  IdleActivity,
} from "./types";

export type { IdleActivity } from "./types";

/** How often Bean does something on her own, chosen in Settings. */
export type ActivityFrequency = "calm" | "normal" | "lively";

// Activities drawn with CSS on Bean's still art; they work without any sheet.
const CSS_ACTIVITIES: IdleActivity[] = [
  "peek",
  "hop",
  "boba",
  "zoomies",
  "patrol",
  "chase",
  "stretch",
  "sniff",
];
// Activities that only exist as sprite sheets (a prop, a new pose).
export const SHEET_ACTIVITIES: IdleActivity[] = [
  "volleyball",
  "bone",
  "read",
  "ball",
  "music",
  "dance",
];

/** Every activity a person can switch on or off, in Settings order. */
export const TOGGLEABLE_ACTIVITIES: IdleActivity[] = [
  "boba",
  "volleyball",
  "ball",
  "bone",
  "read",
  "music",
  "dance",
  "zoomies",
  "patrol",
  "chase",
  "stretch",
  "sniff",
  "peek",
  "hop",
];

// While Claude is unreachable Bean stays drowsy instead of racing around.
const DROWSY_ACTIVITIES: IdleActivity[] = [
  "breathe",
  "peek",
  "stretch",
  "sniff",
  "read",
  "music",
  "bone",
];

export const ACTIVITY_LABELS: Record<IdleActivity, string> = {
  breathe: "gentle breathing",
  peek: "peeking around",
  hop: "a happy hop",
  boba: "sipping boba",
  zoomies: "running zoomies",
  patrol: "trotting around",
  chase: "chasing her tail",
  stretch: "a big stretch",
  sniff: "sniffing around",
  volleyball: "playing volleyball",
  bone: "chewing a bone",
  read: "reading a tiny book",
  ball: "playing with her ball",
  music: "listening to music",
  dance: "a happy dance",
};

/** How long each activity plays before Bean settles back into breathing. */
export const ACTIVITY_DURATIONS_MS: Record<IdleActivity, number> = {
  breathe: 0,
  peek: 2_400,
  hop: 1_000,
  boba: 4_200,
  zoomies: 3_600,
  patrol: 6_200,
  chase: 2_000,
  stretch: 2_600,
  sniff: 2_400,
  volleyball: 5_000,
  bone: 5_000,
  read: 6_000,
  ball: 5_000,
  music: 5_000,
  dance: 4_000,
};

/** The pause between activities, in milliseconds, for each frequency. */
const REST_RANGES_MS: Record<ActivityFrequency, [number, number]> = {
  calm: [14_000, 22_000],
  normal: [6_500, 11_000],
  lively: [3_000, 6_000],
};

export interface ActivityOptions {
  /** Activities whose sprite sheet the asset pack provides. */
  available?: ReadonlySet<IdleActivity>;
  /** Activities switched off in Settings. */
  disabled?: readonly string[];
}

export function isWaitingState(state: BeanState) {
  return state === "idle" || state === "sleepy" || state === "soundOff";
}

export function availableActivities(art: ActivityArt = {}) {
  return new Set(
    (Object.keys(art) as IdleActivity[]).filter((activity) => art[activity]),
  );
}

export function activitiesFor(
  state: BeanState,
  { available, disabled = [] }: ActivityOptions = {},
): IdleActivity[] {
  if (!isWaitingState(state)) return ["breathe"];
  const base =
    state === "sleepy"
      ? DROWSY_ACTIVITIES
      : ["breathe" as const, ...CSS_ACTIVITIES, ...SHEET_ACTIVITIES];
  return base.filter(
    (activity) =>
      activity === "breathe" ||
      ((!SHEET_ACTIVITIES.includes(activity) ||
        (available?.has(activity) ?? false)) &&
        !disabled.includes(activity)),
  );
}

export function nextActivity(
  state: BeanState,
  current: IdleActivity,
  random: () => number = Math.random,
  options: ActivityOptions = {},
): IdleActivity {
  const choices = activitiesFor(state, options).filter(
    (activity) => activity !== current && activity !== "breathe",
  );
  if (choices.length === 0) return "breathe";
  return choices[
    Math.min(choices.length - 1, Math.floor(random() * choices.length))
  ];
}

/** How long to play an activity: two loops of its sheet, or its CSS length. */
export function activityDurationMs(activity: IdleActivity, art?: BeanAsset) {
  const base = ACTIVITY_DURATIONS_MS[activity];
  if (!art || typeof art === "string" || art.loop === false) return base;
  return Math.max(base, Math.round(((2 * art.frames) / art.fps) * 1_000));
}

export function restDelayMs(
  frequency: ActivityFrequency = "normal",
  random: () => number = Math.random,
) {
  const [min, max] = REST_RANGES_MS[frequency] ?? REST_RANGES_MS.normal;
  return min + Math.floor(random() * (max - min));
}

/** The movement art an activity uses when the asset pack provides it. */
export function motionFor(
  activity: IdleActivity | "arrive",
): BeanMotion | null {
  if (activity === "zoomies" || activity === "arrive") return "run";
  if (activity === "patrol") return "walk";
  return null;
}
