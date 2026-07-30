/**
 * Disk-backed full-content document synchronization.
 * Hash on-disk content before each request; send didOpen/didChange only when needed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { languageIdForPath } from "./servers.ts";

/** Minimal notify surface used by document sync (avoids circular imports). */
export interface DocumentNotifyConnection {
	notify(method: string, params?: unknown): void;
}

export type DocumentSyncListener = (uri: string, version: number) => void;

export interface SyncedDocument {
	uri: string;
	absolutePath: string;
	languageId: string;
	version: number;
	hash: string;
	content: string;
}

export class DocumentStore {
	private readonly docs = new Map<string, SyncedDocument>();
	private syncListener?: DocumentSyncListener;

	onSync(listener: DocumentSyncListener): void {
		this.syncListener = listener;
	}

	get(uri: string): SyncedDocument | undefined {
		return this.docs.get(uri);
	}

	clear(): void {
		this.docs.clear();
	}

	forget(uri: string): void {
		this.docs.delete(uri);
	}

	/**
	 * Ensure the language server has the current on-disk contents for `absolutePath`.
	 * Returns the synced document metadata (including version used for diagnostics).
	 */
	async syncFile(
		connection: DocumentNotifyConnection,
		absolutePath: string,
		uri: string,
		signal?: AbortSignal,
	): Promise<SyncedDocument> {
		throwIfAborted(signal);
		const content = await fs.promises.readFile(absolutePath, "utf8");
		throwIfAborted(signal);
		const hash = hashContent(content);
		const languageId = languageIdForPath(absolutePath);
		if (!languageId) {
			throw new Error(`Unsupported file type for LSP sync: ${absolutePath}`);
		}
		const existing = this.docs.get(uri);

		if (!existing) {
			const doc: SyncedDocument = {
				uri,
				absolutePath,
				languageId,
				version: 1,
				hash,
				content,
			};
			// Invalidate diagnostics barrier before notifying so publishes stamp the new epoch.
			this.docs.set(uri, doc);
			this.syncListener?.(uri, doc.version);
			connection.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: doc.version,
					text: content,
				},
			});
			return doc;
		}

		if (existing.hash === hash) {
			return existing;
		}

		const next: SyncedDocument = {
			...existing,
			version: existing.version + 1,
			hash,
			content,
			languageId,
		};
		this.docs.set(uri, next);
		this.syncListener?.(uri, next.version);
		connection.notify("textDocument/didChange", {
			textDocument: { uri, version: next.version },
			contentChanges: [{ text: content }],
		});
		return next;
	}

	/** After external mutation (rename apply/rollback), force the next sync to push content. */
	invalidate(uri: string): void {
		const existing = this.docs.get(uri);
		if (!existing) return;
		this.docs.set(uri, { ...existing, hash: "" });
	}

	/** Close and forget; used on shutdown. */
	closeAll(connection: DocumentNotifyConnection): void {
		for (const doc of this.docs.values()) {
			try {
				connection.notify("textDocument/didClose", {
					textDocument: { uri: doc.uri },
				});
			} catch {
				// shutting down
			}
		}
		this.docs.clear();
	}
}

export function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	const error = new Error(reason ? String(reason) : "Aborted");
	error.name = "AbortError";
	throw error;
}
