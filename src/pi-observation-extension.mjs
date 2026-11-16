/**
 * Pi observation extension foundation (version 1).
 *
 * Additive, read-only observation of an interactive Pi session. The extension
 * binds trusted identity from manager-created config and publishes bounded
 * STRUCTURAL events to an injected callback sink. It never reads or forwards
 * prompt text, images, provider payloads, headers, model output or secrets, and
 * it never changes the selected provider/model or session behavior.
 *
 * This module is a foundation only: nothing here is auto-loaded, mutates global
 * state, opens the network, or launches/kills anything. Explicit launcher and
 * bridge wiring follow later.
 */

import { randomUUID } from "node:crypto";

/** Structural event schema version published by this module. */
export const OBSERVATION_VERSION = 1;

/** Maximum length of a trusted identity string accepted from manager config. */
export const ID_MAX_LENGTH = 256;

/** Events observed, mapped to their structural category. */
export const OBSERVED_EVENTS = Object.freeze({
	session_start: "lifecycle",
	session_shutdown: "lifecycle",
	input: "lifecycle",
	before_agent_start: "lifecycle",
	agent_start: "lifecycle",
	agent_end: "lifecycle",
	session_before_compact: "compaction",
	session_compact: "compaction",
	session_compact_failed: "compaction",
});

const SESSION_START_REASONS = new Set(["startup", "reload", "new", "resume", "fork"]);
const SESSION_SHUTDOWN_REASONS = new Set(["quit", "reload", "new", "resume", "fork"]);
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const INPUT_SOURCES = new Set(["interactive", "rpc", "extension"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);
const TRUSTED_FIELDS = ["worker_id", "task_id", "execution_generation"];

function boundedId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH;
}

/** Use a bounded injected stream id when valid, otherwise generate a unique one. */
function resolveStreamId(value) {
	return boundedId(value) ? value : randomUUID();
}

/** Classify a sink return value without invoking a hostile `then` getter. */
function thenableState(value) {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return "none";
	try {
		return typeof value.then === "function" ? "thenable" : "none";
	} catch {
		return "broken";
	}
}

/** Validate manager-created identity config. Returns { ok, errors, value }. */
export function validateObservationConfig(config) {
	if (!config || typeof config !== "object") {
		return { ok: false, errors: ["config must be an object"], value: null };
	}
	const errors = [];
	for (const field of TRUSTED_FIELDS) {
		if (!boundedId(config[field])) {
			errors.push(`${field} must be a non-empty string of at most ${ID_MAX_LENGTH} characters`);
		}
	}
	if (errors.length > 0) return { ok: false, errors, value: null };
	const value = {};
	for (const field of TRUSTED_FIELDS) value[field] = config[field];
	return { ok: true, errors: [], value };
}

function safeIso(now) {
	try {
		const value = now();
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
		return date.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}

function enumOr(value, allowed, fallback = "unknown") {
	return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function readSessionId(ctx) {
	try {
		const value = ctx?.sessionManager?.getSessionId?.();
		return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : null;
	} catch {
		return null;
	}
}

/**
 * Read the current estimated context usage. Returns null when unavailable,
 * keeping "unknown" distinct from zero. Only numeric fields are forwarded.
 */
function readContextUsage(ctx) {
	let usage;
	try {
		usage = ctx?.getContextUsage?.();
	} catch {
		return null;
	}
	if (!usage || typeof usage !== "object") return null;
	// Nullable unknown is preserved; only nonnegative safe integers / finite
	// nonnegative percents are forwarded.
	const tokens = Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
	const contextWindow = Number.isSafeInteger(usage.contextWindow) && usage.contextWindow >= 0 ? usage.contextWindow : null;
	const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent >= 0 ? usage.percent : null;
	return { tokens, context_window: contextWindow, percent };
}

/**
 * Build bounded structural data for one event. Only fixed enums, booleans and
 * numeric context fields are emitted; raw event content is never copied.
 */
function structuralData(kind, event) {
	const e = event && typeof event === "object" ? event : {};
	switch (kind) {
		case "session_start":
			return { reason: enumOr(e.reason, SESSION_START_REASONS) };
		case "session_shutdown":
			return { reason: enumOr(e.reason, SESSION_SHUTDOWN_REASONS) };
		case "input":
			return {
				source: enumOr(e.source, INPUT_SOURCES),
				streaming_behavior:
					typeof e.streamingBehavior === "string" && STREAMING_BEHAVIORS.has(e.streamingBehavior)
						? e.streamingBehavior
						: null,
			};
		case "before_agent_start":
		case "agent_start":
		case "agent_end":
			// No message_type is derived: the real event exposes prompt/images/
			// systemPrompt, and fabricating a type from absent fields would be a
			// false claim.
			return {};
		case "session_before_compact":
			return { reason: enumOr(e.reason, COMPACTION_REASONS), will_retry: e.willRetry === true };
		case "session_compact":
			return {
				reason: enumOr(e.reason, COMPACTION_REASONS),
				will_retry: e.willRetry === true,
				from_extension: e.fromExtension === true,
			};
		case "session_compact_failed":
			return {
				reason: enumOr(e.reason, COMPACTION_REASONS),
				will_retry: e.willRetry === true,
				from_extension: e.fromExtension === true,
				aborted: e.aborted === true,
				// Bounded code only; never the raw failure message.
				error_code: e.aborted === true ? "aborted" : "compaction_failed",
			};
		default:
			return {};
	}
}

/**
 * Create an injectable observation recorder.
 *
 * @param {object} options
 * @param {{worker_id:string,task_id:string,execution_generation:string}} options.config trusted manager identity
 * @param {(event:object)=>void} options.sink callback receiving bounded version-1 events
 * @param {()=>Date} [options.now] injectable clock
 * @returns {object|null} recorder, or null when config/sink are missing or invalid
 */
export function createObservationRecorder(options = {}) {
	const validation = validateObservationConfig(options.config);
	if (!validation.ok || typeof options.sink !== "function") return null;
	const trusted = validation.value;
	const sink = options.sink;
	const now = typeof options.now === "function" ? options.now : () => new Date();
	const streamId = resolveStreamId(options.streamId);

	let seq = 0;
	let delivered = 0;
	let failed = 0;
	let pending = 0;

	/**
	 * Observe one structural event. Never throws and never blocks. A synchronous
	 * sink failure is reported immediately as delivered:false. A thenable sink is
	 * reported as pending until it settles, and its rejection is caught so it can
	 * never become an unhandled rejection or crash Pi.
	 */
	function observe(kind, event = {}, ctx) {
		if (!Object.prototype.hasOwnProperty.call(OBSERVED_EVENTS, kind)) {
			return { seq: null, delivered: false, pending: false, skipped: true };
		}
		seq += 1;
		const entry = {
			version: OBSERVATION_VERSION,
			observation_stream_id: streamId,
			seq,
			ts: safeIso(now),
			type: OBSERVED_EVENTS[kind],
			event: kind,
			worker_id: trusted.worker_id,
			task_id: trusted.task_id,
			execution_generation: trusted.execution_generation,
			harness_session_id: readSessionId(ctx),
			context: readContextUsage(ctx),
			data: structuralData(kind, event),
		};
		let outcome;
		try {
			outcome = sink(entry);
		} catch {
			failed += 1;
			return { seq, delivered: false, pending: false, settled: Promise.resolve(false), event: entry };
		}

		const state = thenableState(outcome);
		if (state === "broken") {
			failed += 1;
			return { seq, delivered: false, pending: false, settled: Promise.resolve(false), event: entry };
		}
		if (state === "thenable") {
			pending += 1;
			const settled = Promise.resolve(outcome).then(
				() => {
					pending -= 1;
					delivered += 1;
					return true;
				},
				() => {
					pending -= 1;
					failed += 1;
					return false;
				},
			);
			// Delivery is not claimed until the sink promise fulfils.
			return { seq, delivered: false, pending: true, settled, event: entry };
		}

		delivered += 1;
		return { seq, delivered: true, pending: false, settled: Promise.resolve(true), event: entry };
	}

	return {
		observe,
		streamId,
		config: { ...trusted },
		get seq() {
			return seq;
		},
		stats() {
			return { seq, delivered, failed, pending };
		},
	};
}

/**
 * Build the extension binding. Returns an inert object (no registrations) when
 * no explicit manager config/sink is supplied, so loading it has no effect.
 */
export function createPiObservationExtension(options = {}) {
	const validation = validateObservationConfig(options.config);
	const recorder = createObservationRecorder(options);
	const surfaces = new Set();
	const disposers = [];

	if (!recorder) {
		return {
			configured: false,
			errors: validation.errors,
			recorder: null,
			register() {
				return false;
			},
			dispose() {},
		};
	}

	// Registering the same surface twice is refused (returns false) so one event
	// cannot produce duplicate incidents. dispose() unregisters every surface so
	// a later re-register is defined and leak-free.
	function register(pi) {
		if (!pi || typeof pi.on !== "function") return false;
		if (surfaces.has(pi)) return false;
		surfaces.add(pi);
		for (const kind of Object.keys(OBSERVED_EVENTS)) {
			const dispose = pi.on(kind, (event, ctx) => {
				try {
					recorder.observe(kind, event, ctx);
				} catch {
					// Observation must never disrupt the interactive session.
				}
			});
			if (typeof dispose === "function") disposers.push({ pi, dispose });
		}
		return true;
	}

	return {
		configured: true,
		errors: [],
		recorder,
		register,
		dispose() {
			while (disposers.length > 0) {
				const { dispose } = disposers.pop();
				try {
					dispose();
				} catch {
					// Ignore disposal errors.
				}
			}
			surfaces.clear();
		},
	};
}

/**
 * Default export suitable for explicit later loading. Pi calls this with only
 * `pi`, so it stays inert; a later launcher may call it as
 * `piObservationExtension(pi, { config, sink })` to activate observation.
 */
export default function piObservationExtension(pi, options) {
	const extension = createPiObservationExtension(options);
	if (extension.configured) extension.register(pi);
	return extension;
}
