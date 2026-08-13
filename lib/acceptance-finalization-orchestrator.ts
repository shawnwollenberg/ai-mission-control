import type { AcceptanceSourceRevalidationEvidence } from "./acceptance-source-checkpoints";

export type FinalizationCheckpoint = "before_independent_review" | "before_final_cleanup" | "after_final_cleanup";

export async function orchestrateAcceptanceFinalization<TReview, TCleanup>(args: {
  checkpoint: (phase: FinalizationCheckpoint) => AcceptanceSourceRevalidationEvidence;
  persistCheckpoint: (evidence: AcceptanceSourceRevalidationEvidence) => Promise<void> | void;
  runIndependentReview: () => Promise<TReview>;
  validateIndependentReview: (review: TReview, checkpoint: AcceptanceSourceRevalidationEvidence) => void;
  runCleanup: () => Promise<TCleanup>;
  validateCleanup: (cleanup: TCleanup, checkpoint: AcceptanceSourceRevalidationEvidence) => void;
}) {
  let beforeReview: AcceptanceSourceRevalidationEvidence | undefined;
  let review: TReview | undefined;
  let beforeCleanup: AcceptanceSourceRevalidationEvidence | undefined;
  let cleanup: TCleanup | undefined;
  let afterCleanup: AcceptanceSourceRevalidationEvidence | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    beforeReview = args.checkpoint("before_independent_review");
    await args.persistCheckpoint(beforeReview);
    review = await args.runIndependentReview();
    args.validateIndependentReview(review, beforeReview);
  } catch (error) {
    primaryError = error;
  }
  try {
    beforeCleanup = args.checkpoint("before_final_cleanup");
    await args.persistCheckpoint(beforeCleanup);
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  try {
    cleanup = await args.runCleanup();
    if (beforeCleanup) args.validateCleanup(cleanup, beforeCleanup);
    else throw new Error("Cleanup completed without its authoritative source checkpoint");
  } catch (error) {
    cleanupError = error;
  }
  try {
    afterCleanup = args.checkpoint("after_final_cleanup");
    await args.persistCheckpoint(afterCleanup);
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  if (primaryError) {
    if (primaryError instanceof Error && cleanupError)
      Object.defineProperty(primaryError, "cleanupError", { value: cleanupError, enumerable: true });
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!beforeReview || review === undefined || !beforeCleanup || cleanup === undefined || !afterCleanup)
    throw new Error("Acceptance finalization did not produce every authoritative phase result");
  return { beforeReview, review, beforeCleanup, cleanup, afterCleanup } as const;
}
