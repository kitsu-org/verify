import { Config } from "./config";
import { configureLoggers, logger } from "./logging";
import { AgeVerificationSystem } from "./main";

process.on("SIGINT", () => {
    process.exit();
});

process.on("uncaughtException", (err) => {
    logger.fatal`Uncaught exception: ${err}`;
    console.error(err);
    logger.fatal`Press Ctrl+C to exit`;

    // Hang until Ctrl+C is pressed
    Bun.sleepSync(Number.POSITIVE_INFINITY);
    process.exit(1);
});

// Start the server
await configureLoggers();

const config = await Config.load();
await configureLoggers(false, config.config);
const server = new AgeVerificationSystem(config.config);
await server.initialize();
