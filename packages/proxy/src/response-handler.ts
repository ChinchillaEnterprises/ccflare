import type { Account } from "@ccflare/types";
import type { ProxyContext } from "./handlers";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: string;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing
 */
// Forward response to client while streaming analytics to worker
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		response,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
	} = options;

	// Prepare objects once for serialisation
	const requestHeadersObj = Object.fromEntries(requestHeaders.entries());
	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

	// Send START message immediately
	const startMessage: StartMessage = {
		type: "start",
		requestId,
		accountId: account?.id || null,
		method,
		path,
		timestamp,
		requestHeaders: requestHeadersObj,
		requestBody: requestBody
			? Buffer.from(requestBody).toString("base64")
			: null,
		responseStatus: response.status,
		responseHeaders: responseHeadersObj,
		isStream,
		providerName: ctx.provider.name,
		agentUsed: agentUsed || null,
		retryAttempt,
		failoverAttempts,
	};
	try {
		ctx.usageWorker.postMessage(startMessage);
	} catch (error) {
		// Worker may be terminated in compiled binary - don't fail the request
		console.warn("Failed to send start message to worker:", error);
	}

	/*********************************************************************
	 *  STREAMING RESPONSES — tee with Response.clone() and send chunks
	 *********************************************************************/
	if (isStream && response.body) {
		// Clone response once for background consumption.
		const analyticsClone = response.clone();

		(async () => {
			try {
				const reader = analyticsClone.body?.getReader();
				if (!reader) return; // Safety check
				// eslint-disable-next-line no-constant-condition
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) {
						const chunkMsg: ChunkMessage = {
							type: "chunk",
							requestId,
							data: value,
						};
						try {
							ctx.usageWorker.postMessage(chunkMsg);
						} catch (error) {
							// Worker may be terminated - silently continue
							console.warn("Failed to send chunk message to worker:", error);
						}
					}
				}
				// Finished without errors
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: isExpectedResponse(path, analyticsClone),
				};
				try {
					ctx.usageWorker.postMessage(endMsg);
				} catch (error) {
					// Worker may be terminated - silently continue
					console.warn("Failed to send end message to worker:", error);
				}
			} catch (err) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: false,
					error: (err as Error).message,
				};
				try {
					ctx.usageWorker.postMessage(endMsg);
				} catch (error) {
					// Worker may be terminated - silently continue
					console.warn("Failed to send error end message to worker:", error);
				}
			}
		})();

		// Return the ORIGINAL response untouched
		return response;
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	(async () => {
		try {
			const clone = response.clone();
			const bodyBuf = await clone.arrayBuffer();
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody:
					bodyBuf.byteLength > 0
						? Buffer.from(bodyBuf).toString("base64")
						: null,
				success: isExpectedResponse(path, clone),
			};
			try {
				ctx.usageWorker.postMessage(endMsg);
			} catch (error) {
				// Worker may be terminated - silently continue
				console.warn("Failed to send non-streaming end message to worker:", error);
			}
		} catch (err) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				success: false,
				error: (err as Error).message,
			};
			try {
				ctx.usageWorker.postMessage(endMsg);
			} catch (error) {
				// Worker may be terminated - silently continue
				console.warn("Failed to send final error end message to worker:", error);
			}
		}
	})();

	// Immediately return original response (no header/body changes)
	return response;
}
