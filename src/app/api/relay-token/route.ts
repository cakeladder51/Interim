import { createRelayTokenHandler } from "@/server/relay-token-handler";
import { randomBytes } from "node:crypto";

export const POST = createRelayTokenHandler({
  getEnv: () => process.env,
  now: () => Date.now(),
  randomHex: (n) => randomBytes(n).toString("hex"),
});
