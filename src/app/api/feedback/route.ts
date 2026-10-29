import { createFeedbackHandler } from "@/server/feedback-handler";
import { selectFeedbackDeps } from "@/server/feedback-deps";

export const POST = createFeedbackHandler(selectFeedbackDeps());
