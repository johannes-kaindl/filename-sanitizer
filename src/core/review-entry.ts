import type { ReviewReason } from "./decide";
import type { FilenameHit } from "../vendor/kit/filename-policy";

export interface ReviewEntry {
  path: string;
  isFolder: boolean;
  target: string;
  /** `stalled`: die Automatik hält an, weil eine Umbenennung die Frist überschritt. */
  reason: ReviewReason | "identical" | "stalled";
  hits: FilenameHit[];
}
