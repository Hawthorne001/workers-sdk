import { Blob } from "node:buffer";
import { URLSearchParams } from "node:url";
import { type KVNamespace } from "@cloudflare/workers-types/experimental";
import { Miniflare } from "miniflare";
import { FormData } from "undici";
import { fetchKVGetValue, fetchListResult, fetchResult } from "../cfetch";
import { getLocalPersistencePath } from "../dev/get-local-persistence-path";
import { getDefaultPersistRoot } from "../dev/miniflare";
import { UserError } from "../errors";
import { logger } from "../logger";
import type { Config } from "../config";
import type { ComplianceConfig } from "../environment-variables/misc-variables";
import type { ReplaceWorkersTypes } from "miniflare";

/** The largest number of kv items we can pass to the API in a single request. */
const API_MAX = 10000;
// The const below are lowered from the API's true capacity to help avoid
// hammering it with large requests.
export const BATCH_KEY_MAX = API_MAX / 10;
// Limit the number of errors or warnings to logs during a bulk put.
// They might end up filling memory for invalid inputs.
export const BATCH_MAX_ERRORS_WARNINGS = 12;

type KvArgs = {
	binding?: string;
	"namespace-id"?: string;
	preview?: boolean;
};

/**
 * Create a new namespace under the given `accountId` with the given `title`.
 *
 * @returns the generated id of the created namespace.
 */
export async function createKVNamespace(
	complianceConfig: ComplianceConfig,
	accountId: string,
	title: string
): Promise<string> {
	const response = await fetchResult<{ id: string }>(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title,
			}),
		}
	);

	return response.id;
}

/**
 * The information about a namespace that is returned from `listNamespaces()`.
 */
export interface KVNamespaceInfo {
	id: string;
	title: string;
	supports_url_encoding?: boolean;
}

/**
 * Fetch a list of all the namespaces under the given `accountId`.
 */
export async function listKVNamespaces(
	complianceConfig: ComplianceConfig,
	accountId: string,
	limitCalls: boolean = false
): Promise<KVNamespaceInfo[]> {
	const pageSize = 100;
	let page = 1;
	const results: KVNamespaceInfo[] = [];
	while (results.length % pageSize === 0) {
		const json = await fetchResult<KVNamespaceInfo[]>(
			complianceConfig,
			`/accounts/${accountId}/storage/kv/namespaces`,
			{},
			new URLSearchParams({
				per_page: pageSize.toString(),
				order: "title",
				direction: "asc",
				page: page.toString(),
			})
		);
		page++;
		results.push(...json);
		if (limitCalls) {
			break;
		}
		if (json.length < pageSize) {
			break;
		}
	}
	return results;
}

export interface NamespaceKeyInfo {
	name: string;
	expiration?: number;
	metadata?: { [key: string]: unknown };
}

export async function listKVNamespaceKeys(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	prefix = ""
) {
	return await fetchListResult<NamespaceKeyInfo>(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`,
		{},
		new URLSearchParams({ prefix })
	);
}

/**
 * Update a KV namespace title under the given `accountId` with the given `namespaceId`.
 *
 * @returns the updated namespace information.
 */
export async function updateKVNamespace(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	title: string
): Promise<KVNamespaceInfo> {
	return await fetchResult<KVNamespaceInfo>(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
		{
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title,
			}),
		}
	);
}

export async function deleteKVNamespace(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string
) {
	return await fetchResult<{ id: string }>(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
		{ method: "DELETE" }
	);
}

/**
 * Information about a key-value pair, including its "metadata" fields.
 */
export interface KeyValue {
	key: string;
	value: string | Buffer;
	expiration?: number;
	expiration_ttl?: number;
	metadata?: object;
	base64?: boolean;
}

const KeyValueKeys = new Set([
	"key",
	"value",
	"expiration",
	"expiration_ttl",
	"metadata",
	"base64",
]);

/**
 * The object has the specified property.
 */
function hasProperty<T extends object>(
	obj: object,
	property: keyof T
): obj is T {
	return property in obj;
}

/**
 * The object has a required property of the specified type.
 */
function hasTypedProperty<T extends object>(
	obj: object,
	property: keyof T,
	type: string
): obj is T {
	return hasProperty(obj, property) && typeof obj[property] === type;
}

/**
 * The object an optional property, of the specified type.
 */
function hasOptionalTypedProperty<T extends object>(
	obj: object,
	property: keyof T,
	type: string
): obj is Omit<T, typeof property> | T {
	return !hasProperty(obj, property) || typeof obj[property] === type;
}

/**
 * Is the given object a valid `KeyValue` type?
 */
export function isKVKeyValue(keyValue: unknown): keyValue is KeyValue {
	if (
		keyValue === null ||
		typeof keyValue !== "object" ||
		!hasTypedProperty(keyValue, "key", "string") ||
		!hasTypedProperty(keyValue, "value", "string") ||
		!hasOptionalTypedProperty(keyValue, "expiration", "number") ||
		!hasOptionalTypedProperty(keyValue, "expiration_ttl", "number") ||
		!hasOptionalTypedProperty(keyValue, "base64", "boolean") ||
		!hasOptionalTypedProperty(keyValue, "metadata", "object")
	) {
		return false;
	}
	return true;
}

/**
 * Get all the properties on the `keyValue` that are not expected.
 */
export function unexpectedKVKeyValueProps(keyValue: KeyValue): string[] {
	const props = Object.keys(keyValue);
	return props.filter((prop) => !KeyValueKeys.has(prop));
}

/**
 * Turn object with fields into FormData
 */
function asFormData(fields: Record<string, unknown>): FormData {
	const formData = new FormData();

	for (const [name, value] of Object.entries(fields)) {
		formData.append(name, Buffer.isBuffer(value) ? new Blob([value]) : value);
	}

	return formData;
}

export async function putKVKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	keyValue: KeyValue
) {
	let searchParams: URLSearchParams | undefined;
	if (keyValue.expiration || keyValue.expiration_ttl) {
		searchParams = new URLSearchParams();
		if (keyValue.expiration) {
			searchParams.set("expiration", `${keyValue.expiration}`);
		}
		if (keyValue.expiration_ttl) {
			searchParams.set("expiration_ttl", `${keyValue.expiration_ttl}`);
		}
	}
	return await fetchResult(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(
			keyValue.key
		)}`,
		{
			method: "PUT",
			body: keyValue.metadata
				? asFormData({
						value: keyValue.value,
						metadata: JSON.stringify(keyValue.metadata),
					})
				: keyValue.value,
		},
		searchParams
	);
}

export async function getKVKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	key: string
): Promise<ArrayBuffer> {
	return await fetchKVGetValue(
		complianceConfig,
		accountId,
		namespaceId,
		encodeURIComponent(key)
	);
}

export async function deleteKVKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	key: string
) {
	return await fetchResult(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(
			key
		)}`,
		{ method: "DELETE" }
	);
}

/**
 * Formatter for converting e.g. 5328 --> 5,328
 */
export const formatNumber = new Intl.NumberFormat("en-US", {
	notation: "standard",
}).format;

/**
 * Helper function for bulk requests, logs ongoing output to console.
 */
function logBulkProgress(
	operation: "put" | "delete",
	index: number,
	total: number
) {
	logger.log(
		`${operation === "put" ? "Uploaded" : "Deleted"} ${Math.floor(
			(100 * index) / total
		)}% (${formatNumber(index)} out of ${formatNumber(total)})`
	);
}

type BulkGetResponse = {
	values: {
		[key: string]: {
			value: string | object | null;
			metadata?: object;
		};
	};
};

export async function getKVBulkKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	keys: string[]
) {
	const requestPayload = { keys };
	const result = await fetchResult<BulkGetResponse>(
		complianceConfig,
		`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk/get`,
		{
			method: "POST",
			body: JSON.stringify(requestPayload),
			headers: { "Content-Type": "application/json" },
		}
	);
	return result.values;
}

export async function putKVBulkKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	keyValues: KeyValue[],
	quiet = false,
	abortSignal?: AbortSignal
) {
	for (let index = 0; index < keyValues.length; index += BATCH_KEY_MAX) {
		if (!quiet && keyValues.length > BATCH_KEY_MAX) {
			logBulkProgress("put", index, keyValues.length);
		}

		await fetchResult(
			complianceConfig,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
			{
				method: "PUT",
				body: JSON.stringify(keyValues.slice(index, index + BATCH_KEY_MAX)),
				headers: { "Content-Type": "application/json" },
			},
			undefined,
			abortSignal
		);
	}

	if (!quiet && keyValues.length > BATCH_KEY_MAX) {
		logBulkProgress("put", keyValues.length, keyValues.length);
	}
}

export async function deleteKVBulkKeyValue(
	complianceConfig: ComplianceConfig,
	accountId: string,
	namespaceId: string,
	keys: string[],
	quiet = false
) {
	for (let index = 0; index < keys.length; index += BATCH_KEY_MAX) {
		if (!quiet && keys.length > BATCH_KEY_MAX) {
			logBulkProgress("delete", index, keys.length);
		}

		await fetchResult(
			complianceConfig,
			`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
			{
				method: "DELETE",
				body: JSON.stringify(keys.slice(index, index + BATCH_KEY_MAX)),
				headers: { "Content-Type": "application/json" },
			}
		);
	}
	if (!quiet && keys.length > BATCH_KEY_MAX) {
		logBulkProgress("delete", keys.length, keys.length);
	}
}

export function getKVNamespaceId(
	{ preview, binding, "namespace-id": namespaceId }: KvArgs,
	config: Config
): string {
	// nice
	if (namespaceId) {
		return namespaceId;
	}

	// begin pre-flight checks

	// `--binding` is only valid if there's a wrangler configuration.
	if (binding && !config) {
		throw new UserError("--binding specified, but no config file was found.");
	}

	// there's no config. abort here
	if (!config) {
		throw new UserError(
			"Failed to find a config file.\n" +
				"Either use --namespace-id to upload directly or create a configuration file with a binding."
		);
	}

	// there's no KV namespaces
	if (!config.kv_namespaces || config.kv_namespaces.length === 0) {
		throw new UserError(
			"No KV Namespaces configured! Either use --namespace-id to upload directly or add a KV namespace to your wrangler config file."
		);
	}

	const namespace = config.kv_namespaces.find((ns) => ns.binding === binding);

	// we couldn't find a namespace with that binding
	if (!namespace) {
		throw new UserError(
			`A namespace with binding name "${binding}" was not found in the configured "kv_namespaces".`
		);
	}

	// end pre-flight checks

	// we're in preview mode, `--preview true` or `--preview` was passed
	if (preview && namespace.preview_id) {
		namespaceId = namespace.preview_id;
		// We don't want to execute code below if preview is set to true, so we just return. Otherwise we will get errors!
		return namespaceId;
	} else if (preview) {
		throw new UserError(
			`No preview ID found for ${binding}. Add one to your wrangler config file to use a separate namespace for previewing your worker.`
		);
	}

	// either `--preview false`, or preview wasn't passed
	// TODO: should we care? or should we just treat false and undefined the same
	const previewIsDefined = typeof preview !== "undefined";

	// --preview false was passed
	if (previewIsDefined && namespace.id) {
		namespaceId = namespace.id;
		// We don't want to execute code below if preview is set to true, so we just return. Otherwise we can get error!
		return namespaceId;
	} else if (previewIsDefined) {
		throw new UserError(
			`No namespace ID found for ${binding}. Add one to your wrangler config file to use a separate namespace for previewing your worker.`
		);
	}

	// `--preview` wasn't passed
	const bindingHasOnlyOneId =
		(namespace.id && !namespace.preview_id) ||
		(!namespace.id && namespace.preview_id);
	if (bindingHasOnlyOneId) {
		namespaceId = namespace.id || namespace.preview_id;
	} else {
		throw new UserError(
			`${binding} has both a namespace ID and a preview ID. Specify "--preview" or "--preview false" to avoid writing data to the wrong namespace.`
		);
	}

	// shouldn't happen. we should be able to prove this with strong typing.
	// TODO: when we add strongly typed commands, rewrite these checks so they're exhaustive
	if (!namespaceId) {
		throw new Error(
			"Something went wrong trying to determine which namespace to upload to.\n" +
				"Please create a github issue with the command you just ran along with your wrangler configuration."
		);
	}

	return namespaceId;
}

// TODO(soon): once we upgrade to TypeScript 5.2, this should actually use `using`:
//  https://devblogs.microsoft.com/typescript/announcing-typescript-5-2/#using-declarations-and-explicit-resource-management
export async function usingLocalNamespace<T>(
	persistTo: string | undefined,
	config: Config,
	namespaceId: string,
	closure: (namespace: ReplaceWorkersTypes<KVNamespace>) => Promise<T>
): Promise<T> {
	// We need to cast to Config for the getLocalPersistencePath function since
	// it expects a full Config object, even though it only uses compliance_region
	const persist = getLocalPersistencePath(persistTo, config);
	const defaultPersistRoot = getDefaultPersistRoot(persist);
	const mf = new Miniflare({
		script:
			'addEventListener("fetch", (e) => e.respondWith(new Response(null, { status: 404 })))',
		defaultPersistRoot,
		kvNamespaces: { NAMESPACE: namespaceId },
	});
	const namespace = await mf.getKVNamespace("NAMESPACE");
	try {
		return await closure(namespace);
	} finally {
		await mf.dispose();
	}
}
