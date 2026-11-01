import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getAzureManagedIdentityToken, isAzureManagedIdentityAvailable } from "../azure-managed-identity.ts";
import { clampThinkingLevel } from "../models.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { type AzureEndpointOptions, resolveAzureConfig, resolveDeploymentName } from "./azure-openai-config.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

/** getEnvApiKey() returns this for ambient credentials, which are never a usable key. */
const AMBIENT_AUTH_MARKER = "<authenticated>";
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

/** The ambient marker stands in for a credential; it is not one. */
function isUsableApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0 && apiKey !== AMBIENT_AUTH_MARKER;
}

/**
 * How this request authenticates.
 *
 * An explicitly configured key always wins. Managed identity is the fallback, so a deployment that
 * sets no key at all still reaches Azure AI Foundry automatically.
 */
function resolveAzureAuth(options?: AzureOpenAIResponsesOptions): "api-key" | "managed-identity" | "none" {
	if (isUsableApiKey(options?.apiKey)) return "api-key";
	if (isAzureManagedIdentityAvailable(options?.env)) return "managed-identity";
	return "none";
}

function missingCredentialsError(provider: string): Error {
	return new Error(
		`No API key for provider: ${provider}. Set AZURE_OPENAI_API_KEY, or run where Azure assigns ` +
			`the process a managed identity so it can authenticate without one.`,
	);
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "azure-openai-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// Create Azure OpenAI client
			const auth = resolveAzureAuth(options);
			if (auth === "none") {
				throw missingCredentialsError(model.provider);
			}
			const client = createClient(model, auth, options);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let params = buildParams(model, normalizedContext, options, deploymentName, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				grammarToolInputProperties,
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Azure OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	// Managed identity supplies the credential later, in createClient, so an absent key is only
	// fatal when there is no identity to fall back on either.
	if (!isUsableApiKey(apiKey) && !isAzureManagedIdentityAvailable(options?.env)) {
		throw missingCredentialsError(model.provider);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AzureOpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function createClient(
	model: Model<"azure-openai-responses">,
	auth: "api-key" | "managed-identity",
	options?: AzureOpenAIResponsesOptions,
) {
	const headers = { ...getIdentityHeaders(model, options?.identity), ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	const common = {
		apiVersion,
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
		baseURL: baseUrl,
	};

	// apiKey and azureADTokenProvider are mutually exclusive -- AzureOpenAI throws when given both
	// -- so exactly one is passed. The provider is called per request and its result becomes
	// `Authorization: Bearer`; caching lives in azure-managed-identity.ts, so it stays cheap.
	if (auth === "managed-identity") {
		return new AzureOpenAI({
			...common,
			azureADTokenProvider: () => getAzureManagedIdentityToken(options?.env),
		});
	}

	return new AzureOpenAI({ ...common, apiKey: options?.apiKey });
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
) {
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools,
			supportsToolSearch,
		}),
	);
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		},
	});

	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		});
	}
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}
