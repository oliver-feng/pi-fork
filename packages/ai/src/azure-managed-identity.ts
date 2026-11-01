import type { ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/**
 * Azure managed identity tokens for Azure AI Foundry / Azure OpenAI endpoints.
 *
 * Lets the agent reach a model with no key stored anywhere: where Azure assigns the process an
 * identity, that identity is the credential. An explicitly configured AZURE_OPENAI_API_KEY still
 * wins -- see the call site in api/azure-openai-responses.ts -- so this is a default, not a
 * replacement.
 *
 * Deliberately dependency-free (a raw fetch against the identity endpoint rather than
 * @azure/identity) so compiled binaries do not pull in an SDK that brings its own credential
 * chain, config files and interactive browser fallbacks. It also keeps this module import-safe in
 * the browser/Vite builds, which is why env access goes through getProviderEnvValue.
 */

/** Where a container's managed identity hands out tokens, when it has one. */
const IDENTITY_ENDPOINT = "IDENTITY_ENDPOINT";
const IDENTITY_HEADER = "IDENTITY_HEADER";

/** Set on a devbox to a token obtained by hand, where there is no identity endpoint. */
const TOKEN_OVERRIDE = "AZURE_OPENAI_TOKEN";

/** Selects among user-assigned identities. Required when the resource carries more than one. */
const CLIENT_ID = "AZURE_OPENAI_CLIENT_ID";

/**
 * The audience for Azure AI services. Not the resource's own hostname -- a token minted for the
 * endpoint rather than this audience is rejected with a 401 that says nothing about why.
 */
const AUDIENCE = "https://cognitiveservices.azure.com";

/** The IMDS-over-HTTP contract Container Apps and App Service implement. */
const IMDS_API_VERSION = "2019-08-01";

/** Renewed a minute early, so a request never carries a token that expires mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

/** How long a token is assumed good for when the endpoint declines to say. */
const FALLBACK_LIFETIME_MS = 5 * 60_000;

interface CachedToken {
	value: string;
	expiresAt: number;
}

let cached: CachedToken | null = null;

/** Shared so a burst of concurrent requests mints one token rather than one each. */
let inflight: Promise<string> | null = null;

function isFresh(entry: CachedToken | null): entry is CachedToken {
	return entry !== null && entry.expiresAt - Date.now() > EXPIRY_MARGIN_MS;
}

async function mintToken(env?: ProviderEnv): Promise<string> {
	const endpoint = getProviderEnvValue(IDENTITY_ENDPOINT, env);
	const header = getProviderEnvValue(IDENTITY_HEADER, env);

	if (!endpoint || !header) {
		throw new Error(
			`No managed identity is available here (${IDENTITY_ENDPOINT} is unset), so no Azure token can be obtained. ` +
				`Run this where Azure assigns the process an identity, or set ${TOKEN_OVERRIDE} to a token obtained by hand.`,
		);
	}

	// Container Apps and App Service inject IDENTITY_ENDPOINT and IDENTITY_HEADER rather than
	// exposing the IMDS address a VM would use, so this is not the well-known 169.254.169.254 call.
	// The client id is required whenever the resource carries a user-assigned identity: with more
	// than one candidate the endpoint cannot choose, and it fails rather than picking.
	const clientId = getProviderEnvValue(CLIENT_ID, env);
	const url =
		`${endpoint}?resource=${encodeURIComponent(AUDIENCE)}&api-version=${IMDS_API_VERSION}` +
		(clientId ? `&client_id=${encodeURIComponent(clientId)}` : "");

	const response = await fetch(url, { headers: { "X-IDENTITY-HEADER": header } });
	if (!response.ok) {
		throw new Error(`Could not get an Azure token (${response.status}): ${await response.text()}`);
	}

	const body = (await response.json()) as {
		access_token?: string;
		expires_on?: unknown;
		expiresOn?: unknown;
	};
	if (!body.access_token) {
		throw new Error("The identity endpoint returned no access_token.");
	}

	// expires_on is seconds since the epoch, and arrives as a string often enough to be worth
	// coercing rather than trusting.
	const expiresOn = Number(body.expires_on ?? body.expiresOn ?? 0);
	cached = {
		value: body.access_token,
		expiresAt: expiresOn > 0 ? expiresOn * 1000 : Date.now() + FALLBACK_LIFETIME_MS,
	};

	return cached.value;
}

/**
 * Whether a token could be obtained at all, without minting one.
 *
 * Checked before managed identity is offered as a default, so a machine with no identity keeps the
 * provider's own "no API key" error rather than getting one about identities it was never going to
 * have.
 */
export function isAzureManagedIdentityAvailable(env?: ProviderEnv): boolean {
	if (getProviderEnvValue(TOKEN_OVERRIDE, env)) return true;
	return !!(getProviderEnvValue(IDENTITY_ENDPOINT, env) && getProviderEnvValue(IDENTITY_HEADER, env));
}

/** A bearer token for Azure AI Foundry, cached until shortly before it expires. */
export async function getAzureManagedIdentityToken(env?: ProviderEnv): Promise<string> {
	const supplied = getProviderEnvValue(TOKEN_OVERRIDE, env);
	if (supplied) return supplied;

	if (isFresh(cached)) return cached.value;
	if (inflight) return inflight;

	inflight = mintToken(env).finally(() => {
		inflight = null;
	});

	return inflight;
}

/** Drops the cached token. Exported for tests; nothing in the running agent needs it. */
export function resetAzureManagedIdentityCache(): void {
	cached = null;
	inflight = null;
}
