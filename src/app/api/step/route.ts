import { createStepHandler } from "@/server/step-handler";
import { selectDeps } from "@/server/deps";

export const POST = createStepHandler(selectDeps());
