import { loadRelayEnv } from "./config";
import { startRelay } from "./server";

const result = loadRelayEnv(process.env);

if (!result.ok) {
  for (const error of result.errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`Relay starting on port ${result.opts.port}`);

startRelay(result.opts)
  .then(({ port, close }) => {
    console.log(`relay listening on :${port}`);

    // Graceful shutdown
    const shutdown = () => {
      console.log("Shutting down...");
      close().then(() => {
        console.log("Relay closed");
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error("Failed to start relay:", err);
    process.exit(1);
  });
