import { resolveAzureBaseUrl, resolveDeploymentName } from "../api/azure-openai-config.ts";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { getAzureManagedIdentityToken, isAzureManagedIdentityAvailable } from "../azure-managed-identity.ts";
import { getEnvApiKey } from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../types.ts";
import { AZURE_MODELS } from "./azure.models.ts";

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

function resolveAzureModel(model: Model<Api>, options: StreamOptions | undefined): Model<Api> {
	return { ...model, baseUrl: resolveAzureBaseUrl(model, options) };
}

async function withAzureAuth<T extends StreamOptions>(options: T | undefined) {
	const apiKey = options?.apiKey || getEnvApiKey("azure", options?.env);
	if (apiKey && apiKey !== "<authenticated>") return { ...options, apiKey };
	if (
		!isAzureManagedIdentityAvailable(options?.env) ||
		Object.entries(options?.headers ?? {}).some(([name, value]) => name.toLowerCase() === "authorization" && value)
	) {
		return options;
	}
	const token = await getAzureManagedIdentityToken(options?.env);
	return { ...options, apiKey: undefined, headers: { ...options?.headers, Authorization: `Bearer ${token}` } };
}

/** Send the deployment name as the request's model, keeping `model.id` as the catalog id. */
function withDeploymentName<T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined {
	const deploymentName = resolveDeploymentName(model, options);
	if (deploymentName === model.id) return options;
	return {
		...options,
		onPayload: async (payload, payloadModel) => {
			const params = { ...(payload as object), model: deploymentName };
			return (await options?.onPayload?.(params, payloadModel)) ?? params;
		},
	} as T;
}

/**
 * Resolve the Azure endpoint and deployment before dispatch, inside `lazyStream` so an
 * unconfigured endpoint errors on the stream instead of throwing out of `stream()`.
 */
function azureStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () =>
				streams.stream(
					resolveAzureModel(model, options),
					context,
					await withAzureAuth(withDeploymentName(model, options)),
				),
			),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () =>
				streams.streamSimple(
					resolveAzureModel(model, options),
					context,
					await withAzureAuth(withDeploymentName(model, options)),
				),
			),
	};
}

export function azureProvider(): Provider<"azure-openai-responses" | "openai-completions"> {
	return createProvider({
		id: "azure",
		name: "Azure",
		auth: { apiKey: azureAuth },
		models: Object.values(AZURE_MODELS),
		api: {
			"azure-openai-responses": azureOpenAIResponsesApi(),
			"openai-completions": azureStreams(openAICompletionsApi()),
		},
	});
}
