import type { MissionCard } from "./view-model";

const indicatorColors: Record<MissionCard["color"], string> = {
  BLUE: "#1769e0",
  ORANGE: "#d76600",
  RED: "#b00020",
  GRAY: "#6b7280",
  BLACK: "#171717",
  WHITE: "#fafafa",
};

export function missionCardPresentation(color: MissionCard["color"]) {
  return {
    indicator: indicatorColors[color],
    background: color === "WHITE" ? "#fafafa" : "#ffffff",
    foreground: "#171717",
    link: "#0645ad",
  } as const;
}
