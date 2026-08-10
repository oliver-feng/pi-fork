import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "./azure-openai-responses.models.ts";

/**
 * Azure accepts either an explicit `AZURE_OPENAI_API_KEY` or the process's managed identity. A
 * stored key or `AZURE_OPENAI_API_KEY` wins; otherwise, when an endpoint and a managed-identity
 * source are both present, resolve to keyless ambient auth (`{ auth: {} }`) the same way bedrock does
 * for AWS roles -- the request signs itself with a token provider at call time. Without this branch a
 * container with only a managed identity reports "No API key found", because the standard
 * envApiKeyAuth only looks for the key var. The endpoint is required too: a bare identity says
 * nothing about which resource to reach, and every process in Azure has one.
 */
const azureAuth: ApiKeyAuth = {
	name: "Azure OpenAI API key",
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		const key = await interaction.prompt({ type: "secret", message: "Enter Azure OpenAI API key" });
		interaction.signal.throwIfAborted();
		return { type: "api_key", key };
	},
	resolve: async ({ ctx, credential, signal }) => {
		const env = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		if (credential?.key) {
			return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		}
		const apiKey = await env("AZURE_OPENAI_API_KEY");
		if (apiKey) return { auth: { apiKey }, source: "AZURE_OPENAI_API_KEY" };

		const hasEndpoint = Boolean((await env("AZURE_OPENAI_BASE_URL")) || (await env("AZURE_OPENAI_RESOURCE_NAME")));
		if (!hasEndpoint) return undefined;

		if (await env("AZURE_OPENAI_TOKEN")) return { auth: {}, source: "AZURE_OPENAI_TOKEN" };
		if ((await env("IDENTITY_ENDPOINT")) && (await env("IDENTITY_HEADER"))) {
			return { auth: {}, source: "managed identity" };
		}
		return undefined;
	},
};

export function azureOpenAIResponsesProvider(): Provider<"azure-openai-responses"> {
	return createProvider({
		id: "azure-openai-responses",
		name: "Azure OpenAI",
		auth: { apiKey: azureAuth },
		models: Object.values(AZURE_OPENAI_RESPONSES_MODELS),
		api: azureOpenAIResponsesApi(),
	});
}
