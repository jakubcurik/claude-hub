import type { FastifyBaseLogger } from "fastify";
import type { TelemetryRepository } from "./telemetry-repository.js";

const ROLLUP_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Periodicky agreguje surová telemetry data do denních rollupů a po jednom
 * dni mazne staré řádky nad retention window (365 dní). Vrací funkci pro
 * zastavení obou intervalů — volá se z onClose hooku Fastify serveru.
 */
export function startTelemetryAggregator(
  telemetry: TelemetryRepository,
  logger: FastifyBaseLogger
): () => void {
  const rollupTimer = setInterval(() => {
    telemetry.runRollupTick().catch((error) => {
      logger.warn({ error }, "telemetry rollup tick failed");
    });
  }, ROLLUP_INTERVAL_MS);
  rollupTimer.unref?.();

  const pruneTimer = setInterval(() => {
    telemetry.pruneOldData().catch((error) => {
      logger.warn({ error }, "telemetry prune failed");
    });
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  // Spustíme první rollup hned, aby dashboard nečekal celou minutu na první data.
  telemetry.runRollupTick().catch((error) => {
    logger.warn({ error }, "initial telemetry rollup failed");
  });

  return () => {
    clearInterval(rollupTimer);
    clearInterval(pruneTimer);
  };
}
