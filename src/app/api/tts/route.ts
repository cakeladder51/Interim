import { createTtsHandler } from "@/server/tts-handler";
export const POST = createTtsHandler({ getEnv: () => process.env, fetch: (input, init) => fetch(input, init) });
