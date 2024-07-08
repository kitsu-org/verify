import { forward } from "@ngrok/ngrok";
import type { Server, ServerWebSocket } from "bun";
import chalk from "chalk";
import { api } from "misskey-js";
import type { UserDetailed } from "misskey-js/entities.js";
import { Stripe } from "stripe";
import type { IConfig } from "./config";
import { logger } from "./logging";
import { MessageTypes, type WebSocketMessage } from "./messages";

type WebSocketType = ServerWebSocket<{ identity: string }>;

/**
 * Class representing the age verification system
 */
export class AgeVerificationSystem {
    private server: api.APIClient;
    private stripe: Stripe;
    private config: IConfig;
    private accountsOpen: Record<
        string,
        { ws: WebSocketType; stripe?: Stripe.Identity.VerificationSession }
    > = {};

    /**
     * @param config - Configuration object for the application
     */
    constructor(config: IConfig) {
        this.config = config;
        this.server = new api.APIClient({
            origin: config.misskey.url,
            credential: config.misskey.key,
        });
        this.stripe = new Stripe(config.stripe.secret_key, {
            apiVersion: "2024-06-20",
        });
    }

    /**
     * Initializes the system
     */
    async initialize(): Promise<void> {
        logger.info`Booting...`;
        const me = await this.server.request("i", {});
        logger.info`Signed in as ${me.username}`;

        logger.info`Stripe is online`;

        await this.setupServer();
        await this.setupTunnel();
    }

    /**
     * Sets up the Bun server
     */
    private setupServer(): void {
        Bun.serve<{ identity: string }>({
            port: this.config.websockets.port,
            fetch: this.handleHttpRequest,
            websocket: {
                open: this.handleWebSocketOpen,
                message: this.handleWebSocketMessage,
                perMessageDeflate: true,
            },
        });
        logger.info`Server online`;
    }

    /**
     * Sets up ngrok forwarding
     */
    private async setupTunnel(): Promise<void> {
        const tunnel = await forward({
            addr: this.config.websockets.port,
            authtoken: this.config.ngrok.token,
        });
        const url = tunnel.url();
        logger.info`Public URL: ${chalk.gray(url)}`;

        await this.stripe.webhookEndpoints.create({
            enabled_events: [
                "identity.verification_session.verified",
                "identity.verification_session.requires_input",
            ],
            url: new URL("/callback", url ?? "").toString(),
        });
    }

    /**
     * Handles HTTP requests
     * @param req - The incoming request
     * @param server - The server object
     */
    private handleHttpRequest(
        req: Request,
        server: Server,
    ): Promise<Response> | Response | undefined {
        const url = new URL(req.url);

        switch (url.pathname) {
            case "/websockets":
                return this.handleWebSocketUpgrade(req, server);
            case "/callback":
                return this.handleStripeCallback(req);
            case "/api/signup":
                return this.handleSignup();
            default:
                return new Response("Not found", { status: 404 });
        }
    }

    /**
     * Handles WebSocket upgrade requests
     * @param req - The incoming request
     * @param server - The server object
     */
    private handleWebSocketUpgrade(
        req: Request,
        server: Server,
    ): Response | undefined {
        const url = new URL(req.url);
        const identity = url.searchParams.get("identity");
        if (!identity || identity === "GUESTID") {
            return new Response("Invalid identity", { status: 400 });
        }
        const success = server.upgrade(req, { data: { identity } });
        return success
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 500 });
    }

    /**
     * Handles Stripe callback
     * @param req - The incoming request
     */
    private async handleStripeCallback(req: Request): Promise<Response> {
        if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        const info = await req.json();
        const session =
            await this.stripe.identity.verificationSessions.retrieve(
                info.data.object.id,
            );

        switch (info.type) {
            case "identity.verification_session.requires_input":
                // Handle requires_input event
                break;
            case "identity.verification_session.verified":
                if (session.status === "verified") {
                    await this.handleVerifiedSession(session);
                }
                break;
        }

        return new Response(JSON.stringify({ understood: true }));
    }

    /**
     * Handles signup requests
     */
    private handleSignup(): Response {
        return new Response(
            JSON.stringify({
                statusCode: 400,
                error: "Verification Required",
                message:
                    "You're in a location that requires ID Verification. To sign up, visit verify.kitsunes.gay.",
            }),
            {
                status: 400,
                headers: { "Content-Type": "application/json" },
            },
        );
    }

    /**
     * Handles WebSocket open events
     * @param ws - The WebSocket connection
     */
    private handleWebSocketOpen(ws: WebSocketType): void {
        if (ws.data.identity === "NAH") {
            ws.close();
            return;
        }
        logger.debug`${chalk.gray(
            ws.data.identity,
        )}: WebSockets connection open`;
        this.accountsOpen[ws.data.identity] = { ws };
        this.sendMessage(ws, {
            type: MessageTypes.Connected,
        });
    }

    /**
     * Handles WebSocket messages
     * @param ws - The WebSocket connection
     * @param message - The incoming message
     */
    private async handleWebSocketMessage(
        ws: WebSocketType,
        message: string | Buffer,
    ): Promise<void> {
        let msg: WebSocketMessage;
        try {
            msg = JSON.parse(message.toString());
        } catch {
            logger.debug`${chalk.gray(
                ws.data.identity,
            )}: Malformed JSON. Terminating connection.`;
            ws.close();
            return;
        }

        switch (msg.type) {
            case MessageTypes.Verify:
                await this.handleVerifyRequest(ws);
                break;
            case MessageTypes.StripeError:
                await this.handleStripeError(ws, msg.data);
                break;
            case MessageTypes.StripeDone:
                await this.handleStripeDone(ws);
                break;
        }
    }

    /**
     * Handles verify requests
     * @param ws - The WebSocket connection
     */
    private async handleVerifyRequest(ws: WebSocketType): Promise<void> {
        const identity = await this.stripe.identity.verificationSessions.create(
            {
                type: "document",
                metadata: { identity: ws.data.identity },
            },
        );
        this.accountsOpen[ws.data.identity].stripe = identity;
        this.sendMessage(ws, {
            type: MessageTypes.StripeSession,
            data: identity.client_secret ?? "",
        });
    }

    /**
     * Handles Stripe errors
     * @param ws - The WebSocket connection
     * @param data - The error data
     */
    private async handleStripeError(
        ws: WebSocketType,
        data: { code: string },
    ): Promise<void> {
        const errorSession =
            await this.stripe.identity.verificationSessions.retrieve(
                this.accountsOpen[ws.data.identity].stripe?.id ?? "",
            );

        if (data.code === "session_cancelled") {
            return;
        }

        if (errorSession.last_error?.code === "consent_declined") {
            await this.handleConsentDeclined(ws);
        }
    }

    /**
     * Handles consent declined errors
     * @param ws - The WebSocket connection
     */
    private async handleConsentDeclined(ws: WebSocketType): Promise<void> {
        const user = await this.getUserInfo(ws.data.identity.replace("M_", ""));
        await this.updateUserNote(user, "susp/minor\nADM-ID/Perm");
        this.sendMessage(ws, {
            type: MessageTypes.VerificationFailed,
            data: {
                reason: "consent_declined",
            },
        });
    }

    /**
     * Handles Stripe done events
     * @param ws - The WebSocket connection
     */
    private async handleStripeDone(ws: WebSocketType): Promise<void> {
        const session =
            await this.stripe.identity.verificationSessions.retrieve(
                this.accountsOpen[ws.data.identity].stripe?.id ?? "",
            );

        if (session.status === "requires_input") {
            this.sendMessage(ws, {
                type: MessageTypes.VerificationIncomplete,
            });
        }
    }

    /**
     * Handles verified Stripe sessions
     * @param session - The verified Stripe session
     */
    private async handleVerifiedSession(
        session: Stripe.Identity.VerificationSession,
    ): Promise<void> {
        const ws = this.accountsOpen[session.metadata.identity].ws;
        await this.stripe.identity.verificationSessions.redact(session.id);
        const user = await this.getUserInfo(
            session.metadata.identity.replace("M_", ""),
        );
        await this.updateUserNote(user, `ADM-ID/Verified - ${session.id}`);
        this.sendMessage(ws, {
            type: MessageTypes.VerificationComplete,
            data: {
                verificationId: session.id,
            },
        });
    }

    /**
     * Gets user information
     * @param userId - The user ID
     */
    private async getUserInfo(userId: string): Promise<UserDetailed> {
        return await this.server.request("users/show", { userId });
    }

    /**
     * Updates user moderation note
     * @param user - The user object
     * @param newNote - The new moderation note
     */
    private async updateUserNote(
        user: UserDetailed,
        newNote: string,
    ): Promise<void> {
        // @ts-expect-error Misskey's TypeScript is weird
        await this.server.request("admin/update-user-note", {
            userId: user.id,
            text: user.moderationNote?.replace("ADM-ID/minor", newNote),
        });
    }

    /**
     * Send a message as JSON
     * @param ws - The WebSocket connection
     * @param message - Message contents
     */
    private sendMessage(ws: WebSocketType, message: WebSocketMessage): void {
        ws.send(JSON.stringify(message));
    }
}
