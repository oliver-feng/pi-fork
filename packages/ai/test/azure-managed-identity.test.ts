import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import {
	getAzureManagedIdentityToken,
	isAzureManagedIdentityAvailable,
	resetAzureManagedIdentityCache,
} from "../src/azure-managed-identity.ts";
import { getModel } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import type { Context } from "../src/types.ts";

interface CapturedAzureClientOptions {
	apiKey?: string;
	azureADTokenProvider?: () => Promise<string>;
	baseURL: string;
}

const azureMock = vi.hoisted(() => ({
	constructorCalls: [] as CapturedAzureClientOptions[],
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: () => {
				throw new Error("mock create");
			},
		};

		constructor(config: CapturedAzureClientOptions) {
			// The real client rejects both at once; assert the callers never do that.
			if (config.apiKey && config.azureADTokenProvider) {
				throw new Error("apiKey and azureADTokenProvider are mutually exclusive");
			}
			azureMock.constructorCalls.push(config);
		}
	}

	return { AzureOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const ENV_KEYS = [
	"IDENTITY_ENDPOINT",
	"IDENTITY_HEADER",
	"AZURE_OPENAI_TOKEN",
	"AZURE_OPENAI_CLIENT_ID",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
] as const;

const saved = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

type Call = { url: URL; identityHeader: string | null };

function stubIdentityEndpoint(respond: () => Response): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		const url = new URL(raw);
		calls.push({ url, identityHeader: new Headers(init?.headers).get("x-identity-header") });
		return respond();
	}) as typeof globalThis.fetch;
	return calls;
}

function tokenResponse(token: string, expiresInSeconds = 3600): Response {
	return new Response(
		JSON.stringify({
			access_token: token,
			// Azure sends this as a string often enough to be worth covering.
			expires_on: String(Math.floor(Date.now() / 1000) + expiresInSeconds),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

beforeEach(() => {
	azureMock.constructorCalls.length = 0;
	for (const key of ENV_KEYS) {
		saved.set(key, process.env[key]);
		delete process.env[key];
	}
	resetAzureManagedIdentityCache();
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	globalThis.fetch = realFetch;
	resetAzureManagedIdentityCache();
});

describe("azure managed identity token", () => {
	it("is unavailable without an identity endpoint", () => {
		expect(isAzureManagedIdentityAvailable()).toBe(false);

		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		expect(isAzureManagedIdentityAvailable()).toBe(false);

		process.env.IDENTITY_HEADER = "secret";
		expect(isAzureManagedIdentityAvailable()).toBe(true);
	});

	it("prefers a hand-obtained token and needs no endpoint", async () => {
		process.env.AZURE_OPENAI_TOKEN = "devbox-token";
		expect(isAzureManagedIdentityAvailable()).toBe(true);
		expect(await getAzureManagedIdentityToken()).toBe("devbox-token");
	});

	it("requests the cognitiveservices audience with the identity header", async () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		const calls = stubIdentityEndpoint(() => tokenResponse("minted"));

		expect(await getAzureManagedIdentityToken()).toBe("minted");
		expect(calls).toHaveLength(1);
		expect(calls[0].identityHeader).toBe("secret");
		expect(calls[0].url.searchParams.get("resource")).toBe("https://cognitiveservices.azure.com");
		expect(calls[0].url.searchParams.get("api-version")).toBe("2019-08-01");
		expect(calls[0].url.searchParams.get("client_id")).toBeNull();
	});

	it("passes the client id for a user-assigned identity", async () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		process.env.AZURE_OPENAI_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
		const calls = stubIdentityEndpoint(() => tokenResponse("minted"));

		await getAzureManagedIdentityToken();
		expect(calls[0].url.searchParams.get("client_id")).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("caches a live token and shares one in-flight mint", async () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		let issued = 0;
		const calls = stubIdentityEndpoint(() => tokenResponse(`token-${++issued}`));

		const results = await Promise.all([
			getAzureManagedIdentityToken(),
			getAzureManagedIdentityToken(),
			getAzureManagedIdentityToken(),
		]);
		expect(results).toEqual(["token-1", "token-1", "token-1"]);
		expect(await getAzureManagedIdentityToken()).toBe("token-1");
		expect(calls).toHaveLength(1);
	});

	it("re-mints a token that is inside the expiry margin", async () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		let issued = 0;
		// 30s of life left is inside the 60s margin, so it must never be reused.
		stubIdentityEndpoint(() => tokenResponse(`short-${++issued}`, 30));

		expect(await getAzureManagedIdentityToken()).toBe("short-1");
		expect(await getAzureManagedIdentityToken()).toBe("short-2");
	});

	it("reports a failing identity endpoint with its status and body", async () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		stubIdentityEndpoint(() => new Response("no identity assigned", { status: 400 }));

		await expect(getAzureManagedIdentityToken()).rejects.toThrow(/400/);
	});

	it("explains itself when there is no identity at all", async () => {
		await expect(getAzureManagedIdentityToken()).rejects.toThrow(/IDENTITY_ENDPOINT is unset/);
	});
});

describe("azure provider discovery", () => {
	it("is unconfigured with an identity but no endpoint", () => {
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		expect(getEnvApiKey("azure-openai-responses")).toBeUndefined();
	});

	it("is unconfigured with an endpoint but no identity", () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "probe";
		expect(getEnvApiKey("azure-openai-responses")).toBeUndefined();
	});

	it("reports ambient auth once both are present", () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "probe";
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		expect(getEnvApiKey("azure-openai-responses")).toBe("<authenticated>");
	});

	it("still prefers an explicit API key", () => {
		process.env.AZURE_OPENAI_API_KEY = "real-key";
		process.env.AZURE_OPENAI_RESOURCE_NAME = "probe";
		process.env.IDENTITY_ENDPOINT = "http://localhost/identity";
		process.env.IDENTITY_HEADER = "secret";
		expect(getEnvApiKey("azure-openai-responses")).toBe("real-key");
	});
});

describe("azure client credential selection", () => {
	async function runStream(options: { apiKey?: string }) {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "probe";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, context, options).result();
	}

	it("uses a token provider when only an identity is present", async () => {
		process.env.AZURE_OPENAI_TOKEN = "identity-token";
		await runStream({});

		expect(azureMock.constructorCalls).toHaveLength(1);
		const call = azureMock.constructorCalls[0];
		expect(call.apiKey).toBeUndefined();
		expect(call.azureADTokenProvider).toBeTypeOf("function");
		expect(await call.azureADTokenProvider?.()).toBe("identity-token");
	});

	it("uses the api key when one is configured, even alongside an identity", async () => {
		process.env.AZURE_OPENAI_TOKEN = "identity-token";
		await runStream({ apiKey: "real-key" });

		expect(azureMock.constructorCalls).toHaveLength(1);
		const call = azureMock.constructorCalls[0];
		expect(call.apiKey).toBe("real-key");
		expect(call.azureADTokenProvider).toBeUndefined();
	});

	it("treats the ambient marker as a missing key and falls back to the identity", async () => {
		process.env.AZURE_OPENAI_TOKEN = "identity-token";
		await runStream({ apiKey: "<authenticated>" });

		expect(azureMock.constructorCalls).toHaveLength(1);
		expect(azureMock.constructorCalls[0].azureADTokenProvider).toBeTypeOf("function");
	});

	it("fails with a credential error when there is neither", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "probe";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const result = await streamAzureOpenAIResponses(model, context, {}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/managed identity/i);
		expect(azureMock.constructorCalls).toHaveLength(0);
	});
});
