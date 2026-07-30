import {
	completeSimple,
	type Api,
	type AssistantMessage,
	type Context as ModelContext,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DirectCompleteFunction = typeof completeSimple;

type ModelRegistry = ExtensionContext["modelRegistry"];

function cancellationError(signal: AbortSignal): unknown {
	return signal.reason ?? Object.assign(new Error("Cancelled"), { name: "AbortError" });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw cancellationError(signal);
}

function withCancellation<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(cancellationError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(cancellationError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Authenticated one-shot completion with custom-provider support.
 *
 * Deterministic precedence for the completion backend:
 * 1. Runtime-registered provider `streamSimple` (via modelRegistry)
 * 2. Caller-supplied `override` complete function
 * 3. Default `completeSimple`
 *
 * Resolves auth via getApiKeyAndHeaders, throws on auth failure, and injects
 * apiKey/headers/env into the request options. Does not add tools or mutate
 * the model context or session.
 */
export async function completeDirectRequest(
	modelRegistry: ModelRegistry,
	model: Model<Api>,
	context: ModelContext,
	requestOptions: SimpleStreamOptions,
	override?: DirectCompleteFunction,
): Promise<AssistantMessage> {
	throwIfAborted(requestOptions.signal);
	const auth = await withCancellation(
		modelRegistry.getApiKeyAndHeaders(model),
		requestOptions.signal,
	);
	if (!auth.ok) throw new Error(auth.error);
	throwIfAborted(requestOptions.signal);

	const options: SimpleStreamOptions = {
		...requestOptions,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};

	const customStream = modelRegistry.getRegisteredProviderConfig(model.provider)?.streamSimple;
	if (customStream) {
		return withCancellation(customStream(model, context, options).result(), requestOptions.signal);
	}
	if (override) return withCancellation(override(model, context, options), requestOptions.signal);
	return withCancellation(completeSimple(model, context, options), requestOptions.signal);
}
