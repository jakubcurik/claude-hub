import cors from "@fastify/cors";
import fastify from "fastify";
import { RegistryRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";

const host = process.env.CLAUDE_HUB_API_HOST ?? "127.0.0.1";
const port = Number(process.env.CLAUDE_HUB_API_PORT ?? 8787);

const app = fastify({
  logger: true
});

await app.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/]
});

const repository = new RegistryRepository();
await repository.init();

app.addHook("onClose", async () => {
  await repository.close();
});

await registerRoutes(app, repository);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
