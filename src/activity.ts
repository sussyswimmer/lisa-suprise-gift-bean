import { BeanMotion, BeanState } from "./types";

/** Little things Bean does on her own while Claude is quiet. */
export type IdleActivity =
  | "breathe"
  | "peek"
  | "hop"
  | "boba"
  | "zoomies"
  | "patrol"
  | "chase"
  | "stretch"
  | "sniff";

const AWAKE_ACTIVITIES: IdleActivity[] = [
  "breathe",
  "peek",
  "hop",
  "boba",
  "zoomies",
  "patrol",
  "chase",
  "stretch",
  "sniff",
];
// While Claude is unreachable Bean stays drowsy instead of racing around.
const DROWSY_ACTIVITIES: IdleActivity[] = [
  "breathe",
  "peek",
  "stretch",
  "sniff",
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
};

export function isWaitingState(state: BeanState) {
  return state === "idle" || state === "sleepy" || state === "soundOff";
}

export function activitiesFor(state: BeanState): IdleActivity[] {
  if (state === "sleepy") return DROWSY_ACTIVITIES;
  return isWaitingState(state) ? AWAKE_ACTIVITIES : ["breathe"];
}

export function nextActivity(
  state: BeanState,
  current: IdleActivity,
  random: () => number = Math.random,
): IdleActivity {
  const choices = activitiesFor(state).filter(
    (activity) => activity !== current,
  );
  if (choices.length === 0) return "breathe";
  return choices[
    Math.min(choices.length - 1, Math.floor(random() * choices.length))
  ];
}

/** The movement art an activity uses when the asset pack provides it. */
export function motionFor(
  activity: IdleActivity | "arrive",
): BeanMotion | null {
  if (activity === "zoomies" || activity === "arrive") return "run";
  if (activity === "patrol") return "walk";
  return null;
}
