import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastify from "fastify";
import { RegistryRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";
import { TelemetryRepository } from "./telemetry-repository.js";
import { startTelemetryAggregator } from "./telemetry-aggregator.js";

const host = process.env.CLAUDE_HUB_API_HOST ?? "127.0.0.1";
const port = Number(process.env.CLAUDE_HUB_API_PORT ?? 8787);
const sessionCleanupIntervalMs = Number(
  process.env.CLAUDE_HUB_SESSION_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000
);

const app = fastify({
  logger: true
});

await app.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/]
});

await app.register(rateLimit, {
  global: false,
  max: 100,
  timeWindow: "1 minute"
});

const repository = new RegistryRepository();
await repository.init();

const cleanupTimer = setInterval(() => {
  repository.cleanupExpiredSessions().catch((error) => {
    app.log.warn({ error }, "session cleanup failed");
  });
}, sessionCleanupIntervalMs);
cleanupTimer.unref?.();

const telemetry = new TelemetryRepository(repository.pool);
const stopAggregator = startTelemetryAggregator(telemetry, app.log);

app.addHook("onClose", async () => {
  clearInterval(cleanupTimer);
  stopAggregator();
  await repository.close();
});

await registerRoutes(app, repository, telemetry);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
