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
    // DEP. Removed the sleepSync so that the backend can crash without assistance.
    //    Bun.sleepSync(Number.POSITIVE_INFINITY);
    process.exit(1);
});

// Start the server
await configureLoggers();

const config = await Config.load();
await configureLoggers(false, config.config);

if (
    config.config.stripe.secret_key.startsWith("sk_live_") &&
    config.config.environment === "debug"
) {
    logger.warn`You are using a live Stripe key in a debug environment! This is discouraged.`;
}

const server = new AgeVerificationSystem(config.config);
await server.initialize();
