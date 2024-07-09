import { beforeAll, describe, expect, jest, mock, test } from "bun:test";
import { Stripe } from "stripe";
import WebSocket from "ws";
import type { IConfig } from "./config";
import { AgeVerificationSystem } from "./main";
import { MessageTypes } from "./messages";

// Mock configuration
const mockConfig: IConfig = {
	environment: "debug",
	misskey: { url: "https://mockMisskey.com", key: "mockKey" },
	stripe: { secret_key: "mockStripeKey" },
	websockets: { port: 3000, host: "0.0.0.0" },
	ngrok: { token: "mockNgrokToken" },
	logging: {
		level: "debug",
	},
};

// Mocks
const apiRequestMock = jest.fn();
const apiMock = jest.fn(() => ({
	request: apiRequestMock,
}));

const stripeMock = {
	identity: {
		verificationSessions: {
			create: jest.fn(),
			retrieve: jest.fn(),
			redact: jest.fn(),
		},
	},
	webhookEndpoints: {
		create: jest.fn(),
	},
};

mock.module("stripe", () => ({
	Stripe: jest.fn(() => stripeMock),
}));

mock.module("misskey-js", () => ({
	api: {
		APIClient: apiMock,
	},
}));

mock.module("@ngrok/ngrok", () => ({
	forward: jest.fn().mockResolvedValue({ url: () => "https://mockngrok.com" }),
}));

let system: AgeVerificationSystem;

beforeAll(async () => {
	// Setup mocks for different Misskey API calls
	// biome-ignore lint/suspicious/noExplicitAny: In tests
	apiRequestMock.mockImplementation((type: string, params: any) => {
		switch (type) {
			case "i":
				return Promise.resolve({ username: "testUser" });
			case "users/show":
				return Promise.resolve({
					id: params.userId,
					moderationNote: "ADM-ID/minor",
				});
			case "admin/update-user-note":
				return Promise.resolve();
			default:
				return Promise.reject(new Error("Unexpected API call"));
		}
	});

	system = new AgeVerificationSystem(mockConfig);
	await system.initialize();
});

describe("AgeVerificationSystem", () => {
	test("initialization", () => {
		expect(apiMock).toHaveBeenCalledWith({
			origin: mockConfig.misskey.url,
			credential: mockConfig.misskey.key,
		});
		expect(Stripe).toHaveBeenCalledWith(mockConfig.stripe.secret_key, {
			apiVersion: "2024-06-20",
		});
		expect(apiRequestMock).toHaveBeenCalledWith("i", {});
	});

	test("setupTunnel", () => {
		expect(stripeMock.webhookEndpoints.create).toHaveBeenCalledWith({
			enabled_events: [
				"identity.verification_session.verified",
				"identity.verification_session.requires_input",
			],
			url: "https://mockngrok.com/callback",
		});
	});

	test("WebSocket connection", (done) => {
		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);

		ws.on("open", () => {
			expect(ws.readyState).toBe(WebSocket.OPEN);
			ws.close();
			done();
		});

		ws.on("error", (error) => {
			done(error);
		});
	});

	test("WebSocket message handling - Verify request", (done) => {
		stripeMock.identity.verificationSessions.create.mockResolvedValue({
			client_secret: "mock_client_secret",
		});

		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);

		ws.on("open", () => {
			ws.send(JSON.stringify({ type: MessageTypes.Verify }));
		});

		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === MessageTypes.Connected) {
				return;
			}
			expect(message.type).toBe(MessageTypes.StripeSession);
			expect(message.data).toBe("mock_client_secret");
			expect(
				stripeMock.identity.verificationSessions.create,
			).toHaveBeenCalledWith({
				type: "document",
				metadata: { identity: "testUser" },
			});
			ws.close();
			done();
		});

		ws.on("error", (error) => {
			done(error);
		});
	});

	test("Stripe callback handling - Verified session", async () => {
		const mockSession = {
			id: "mockSessionId",
			status: "verified",
			metadata: { identity: "testUser" },
		};

		stripeMock.identity.verificationSessions.retrieve.mockResolvedValue(
			mockSession,
		);
		stripeMock.identity.verificationSessions.redact.mockResolvedValue({});

		const response = await fetch("http://localhost:3000/callback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "identity.verification_session.verified",
				data: { object: { id: "mockSessionId" } },
			}),
		});

		expect(response.status).toBe(200);
		const responseBody = await response.json();
		expect(responseBody).toEqual({ understood: true });

		expect(
			stripeMock.identity.verificationSessions.retrieve,
		).toHaveBeenCalledWith("mockSessionId");
		expect(
			stripeMock.identity.verificationSessions.redact,
		).toHaveBeenCalledWith("mockSessionId");
		expect(apiRequestMock).toHaveBeenCalledWith("users/show", {
			userId: "testUser",
		});
		expect(apiRequestMock).toHaveBeenCalledWith("admin/update-user-note", {
			userId: "testUser",
			text: "ADM-ID/Verified - mockSessionId",
		});
	});

	test("Signup request handling", async () => {
		const response = await fetch("http://localhost:3000/api/signup");
		expect(response.status).toBe(400);
		const responseBody = await response.json();
		expect(responseBody).toEqual({
			statusCode: 400,
			error: "Verification Required",
			message:
				"You're in a location that requires ID Verification. To sign up, visit verify.kitsunes.gay.",
		});
	});

	test("Error handling - Consent Declined", (done) => {
		stripeMock.identity.verificationSessions.retrieve.mockResolvedValue({
			last_error: { code: "consent_declined" },
		});
		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);
		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: MessageTypes.StripeError,
					data: { code: "consent_declined" },
				}),
			);
		});
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === MessageTypes.Connected) {
				return;
			}
			expect(message.type).toBe(MessageTypes.VerificationFailed);
			expect(message.data.reason).toBe("noconsent");
			ws.close();
			done();
		});
	});

	test("Error handling - Underaged User", (done) => {
		stripeMock.identity.verificationSessions.retrieve.mockResolvedValue({
			last_error: { code: "under_supported_age" },
		});

		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);

		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: MessageTypes.StripeError,
					data: { code: "under_supported_age" },
				}),
			);
		});

		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === MessageTypes.Connected) {
				return;
			}
			expect(message.type).toBe(MessageTypes.VerificationFailed);
			expect(message.data.reason).toBe("underage");
			expect(apiRequestMock).toHaveBeenCalledWith("users/show", {
				userId: "testUser",
			});
			expect(apiRequestMock).toHaveBeenCalledWith("admin/update-user-note", {
				userId: "testUser",
				text: "susp/minor\nADM-ID/Perm",
			});
			ws.close();
			done();
		});

		ws.on("error", (error) => {
			done(error);
		});
	});

	test("Stripe done handling - Requires input", (done) => {
		stripeMock.identity.verificationSessions.retrieve.mockResolvedValue({
			status: "requires_input",
		});

		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);

		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: MessageTypes.StripeDone,
				}),
			);
		});

		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === MessageTypes.Connected) {
				return;
			}
			expect(message.type).toBe(MessageTypes.VerificationIncomplete);
			ws.close();
			done();
		});

		ws.on("error", (error) => {
			done(error);
		});
	});

	test("Invalid WebSocket message", (done) => {
		const ws = new WebSocket(
			`ws://localhost:${mockConfig.websockets.port}/websockets?identity=testUser`,
		);

		ws.on("open", () => {
			ws.send("Invalid JSON");
		});

		ws.on("close", () => {
			done();
		});

		ws.on("error", (error) => {
			done(error);
		});
	});
});
