import { loadConfig } from "c12";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { logger } from "./logging";

const ConfigSchema = z.object({
    environment: z
        .enum(["debug","production"])
        .default("production")
    stripe: z.object({
        secret_key: z.string().default(""),
    }),
    misskey: z.object({
        url: z.string().url(),
        key: z.string().min(1),
    }),
    ngrok: z.object({
        token: z.string(),
    }),
    websockets: z
        .object({
            port: z.number().int().min(1).max(65535).default(3000),
            host: z.string().default("0.0.0.0"),
        })
        .default({
            port: 3000,
            host: "0.0.0.0",
        }),
    logging: z
        .object({
            level: z
                .enum(["debug", "info", "warning", "error", "fatal"])
                .default("info"),
        })
        .default({
            level: "info",
        }),
});

export type IConfig = z.infer<typeof ConfigSchema>;

/**
 * The Config class represents the configuration of the server.
 */
export class Config {
    /**
     * Constructs a new Config instance.
     * @param {IConfig} config - The configuration object.
     */
    constructor(public config: IConfig) {}

    /**
     * Loads the configuration from the config file.
     * @returns {Promise<Config>} The loaded configuration.
     */
    static async load(): Promise<Config> {
        const { config } = await loadConfig<IConfig>({
            configFile: "config/config.toml",
        });

        const parsed = await ConfigSchema.safeParseAsync(config);

        if (!parsed.success) {
            const error = fromZodError(parsed.error);

            logger.fatal`Invalid configuration: ${error.message}`;
            logger.fatal`Press Ctrl+C to exit`;

            // Hang until Ctrl+C is pressed
            await Bun.sleep(Number.POSITIVE_INFINITY);
            process.exit(1);
        }
        // Test stripe keys for possible mistake
        .refine(data => {
            data.stripe.secret_key.startsWith("sk_test_") && data.environment !== "debug",
            `Stripe testing keys are not permitted to be used in production!`
        })
        
        return new Config(parsed.data);
    }
}
