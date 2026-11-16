import { test } from "node:test";
import assert from "node:assert/strict";

import piObservationExtension, {
	OBSERVATION_VERSION,
	OBSERVED_EVENTS,
	ID_MAX_LENGTH,
	createPiObservationExtension,
	createObservationRecorder,
	validateObservationConfig,
} from "../src/pi-observation-extension.mjs";

const WORKER = { worker_id: "worker-1", task_id: "task-1", execution_generation: "gen-1" };

function createFakePi() {
	const handlers = new Map();
	const tools = [];
	const commands = [];
	return {
		tools,
		commands,
		handlers,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {
				const list = handlers.get(event) ?? [];
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		registerTool(tool) {
			tools.push(tool);
		},
		registerCommand(name, definition) {
			commands.push({ name, definition });
		},
		async emit(event, payload, ctx) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
	};
}

function makeHarness({ sink, usage, sessionId = "sess-1", config = WORKER, streamId = "stream-1" } = {}) {
	const pi = createFakePi();
	const state = { sessionId, aborts: 0, shutdowns: 0 };
	const ctx = {
		model: { provider: "anthropic", id: "claude-test" },
		sessionManager: { getSessionId: () => state.sessionId },
		getContextUsage: () => usage,
		abort() {
			state.aborts += 1;
		},
		shutdown() {
			state.shutdowns += 1;
		},
		setSessionId(value) {
			state.sessionId = value;
		},
	};
	const ext = piObservationExtension(pi, { config, sink, streamId, now: () => new Date("2020-01-01T00:00:00.000Z") });
	return { pi, ctx, ext, state };
}

test("publishes versioned lifecycle events with per-instance sequence", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event) });
	await h.pi.emit("session_start", { type: "session_start", reason: "startup" }, h.ctx);
	await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
	await h.pi.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant" }] }, h.ctx);

	assert.equal(events.length, 3);
	assert.deepEqual(
		events.map((event) => event.seq),
		[1, 2, 3],
	);
	for (const event of events) {
		assert.equal(event.version, OBSERVATION_VERSION);
		assert.equal(event.worker_id, "worker-1");
		assert.equal(event.task_id, "task-1");
		assert.equal(event.execution_generation, "gen-1");
		assert.equal(event.observation_stream_id, "stream-1");
		assert.equal(event.harness_session_id, "sess-1");
		assert.equal(event.type, "lifecycle");
		assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	}
	assert.equal(events[0].event, "session_start");
	assert.deepEqual(events[0].data, { reason: "startup" });
	assert.deepEqual(events[2].data, {});
});

test("categorizes compaction events and emits one bounded failure incident per event", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event) });
	await h.pi.emit(
		"session_compact_failed",
		{
			type: "session_compact_failed",
			reason: "overflow",
			aborted: true,
			willRetry: true,
			fromExtension: false,
			errorMessage: "SECRET failure detail sk-abc123",
		},
		h.ctx,
	);
	assert.equal(events.length, 1);
	const event = events[0];
	assert.equal(event.type, "compaction");
	assert.deepEqual(event.data, {
		reason: "overflow",
		will_retry: true,
		from_extension: false,
		aborted: true,
		error_code: "aborted",
	});
	assert.ok(!JSON.stringify(events).includes("SECRET"));
	assert.ok(!JSON.stringify(events).includes("sk-abc123"));
	assert.ok(!("errorMessage" in event.data));

	await h.pi.emit("session_compact", { reason: "threshold", willRetry: false, fromExtension: true }, h.ctx);
	assert.equal(events[1].type, "compaction");
	assert.equal(events[1].data.from_extension, true);
});

test("keeps unknown context usage null instead of zero", async () => {
	const withNulls = [];
	const h = makeHarness({ sink: (event) => withNulls.push(event), usage: { tokens: null, contextWindow: 4096, percent: null } });
	await h.pi.emit("agent_start", {}, h.ctx);
	assert.deepEqual(withNulls[0].context, { tokens: null, context_window: 4096, percent: null });

	const unavailable = [];
	const h2 = makeHarness({ sink: (event) => unavailable.push(event), usage: undefined });
	await h2.pi.emit("agent_start", {}, h2.ctx);
	assert.equal(unavailable[0].context, null);

	const thrown = [];
	const h3 = makeHarness({ sink: (event) => thrown.push(event), usage: undefined });
	h3.ctx.getContextUsage = () => {
		throw new Error("no usage yet");
	};
	await h3.pi.emit("agent_start", {}, h3.ctx);
	assert.equal(thrown[0].context, null);
});

test("forwards only nonnegative safe context numbers and preserves unknown", async () => {
	const good = [];
	const h = makeHarness({ sink: (event) => good.push(event), usage: { tokens: 12, contextWindow: 4096, percent: 0.5 } });
	await h.pi.emit("agent_start", {}, h.ctx);
	assert.deepEqual(good[0].context, { tokens: 12, context_window: 4096, percent: 0.5 });

	const bad = [];
	const h2 = makeHarness({ sink: (event) => bad.push(event), usage: { tokens: -1, contextWindow: 1.5, percent: Number.POSITIVE_INFINITY } });
	await h2.pi.emit("agent_start", {}, h2.ctx);
	assert.deepEqual(bad[0].context, { tokens: null, context_window: null, percent: null });

	const unsafe = [];
	const h3 = makeHarness({ sink: (event) => unsafe.push(event), usage: { tokens: Number.MAX_SAFE_INTEGER + 2, contextWindow: 0, percent: 0 } });
	await h3.pi.emit("agent_start", {}, h3.ctx);
	assert.deepEqual(unsafe[0].context, { tokens: null, context_window: 0, percent: 0 });
});

test("distinguishes session-id changes without rewriting execution_generation", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event) });
	await h.pi.emit("session_start", { reason: "startup" }, h.ctx);
	h.ctx.setSessionId("sess-2");
	await h.pi.emit("session_start", { reason: "new" }, h.ctx);

	assert.equal(events[0].harness_session_id, "sess-1");
	assert.equal(events[1].harness_session_id, "sess-2");
	assert.equal(events[0].execution_generation, events[1].execution_generation);
	assert.equal(events[0].execution_generation, "gen-1");
});

test("default export is inert without explicit manager config", () => {
	const pi = createFakePi();
	const ext = piObservationExtension(pi);
	assert.equal(ext.configured, false);
	assert.equal(ext.recorder, null);
	assert.equal(pi.handlers.size, 0);
	assert.equal(pi.tools.length, 0);
	assert.equal(pi.commands.length, 0);

	const invalid = createPiObservationExtension({ config: { worker_id: "", task_id: "t", execution_generation: "g" }, sink: () => {} });
	assert.equal(invalid.configured, false);
	assert.ok(invalid.errors.length > 0);
});

test("sink failure never crashes the worker or claims delivery", async () => {
	let calls = 0;
	const h = makeHarness({
		sink: () => {
			calls += 1;
			throw new Error("sink down");
		},
	});
	const results = await h.pi.emit("agent_start", {}, h.ctx);
	assert.equal(calls, 1);
	assert.deepEqual(results, [undefined]);
	assert.deepEqual(h.ext.recorder.stats(), { seq: 1, delivered: 0, failed: 1, pending: 0 });

	await h.pi.emit("agent_end", {}, h.ctx);
	assert.deepEqual(h.ext.recorder.stats(), { seq: 2, delivered: 0, failed: 2, pending: 0 });
	assert.equal(h.state.aborts, 0);
	assert.equal(h.state.shutdowns, 0);
});

test("never forwards prompt text, images, system prompt, or failure messages", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event) });
	await h.pi.emit(
		"input",
		{ type: "input", text: "SECRET-PROMPT", images: [{ data: "SECRET-IMG" }], source: "interactive", streamingBehavior: "steer" },
		h.ctx,
	);
	await h.pi.emit(
		"before_agent_start",
		{ type: "before_agent_start", messageType: "user", prompt: "SECRET-PROMPT", images: [{ data: "SECRET-IMG" }], systemPrompt: "SECRET-SYS" },
		h.ctx,
	);
	await h.pi.emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "SECRET-ERR" }, h.ctx);

	const serialized = JSON.stringify(events);
	for (const secret of ["SECRET-PROMPT", "SECRET-IMG", "SECRET-SYS", "SECRET-ERR"]) {
		assert.ok(!serialized.includes(secret), `leaked ${secret}`);
	}
	assert.deepEqual(events[0].data, { source: "interactive", streaming_behavior: "steer" });
	assert.deepEqual(events[1].data, {});
	assert.deepEqual(events[2].data, {
		reason: "manual",
		will_retry: false,
		from_extension: false,
		aborted: false,
		error_code: "compaction_failed",
	});
});

test("registers observation handlers only, leaving tools, commands, and model untouched", () => {
	const pi = createFakePi();
	const ext = piObservationExtension(pi, { config: WORKER, sink: () => {} });
	assert.equal(ext.configured, true);
	assert.equal(pi.tools.length, 0);
	assert.equal(pi.commands.length, 0);
	assert.deepEqual([...pi.handlers.keys()].sort(), Object.keys(OBSERVED_EVENTS).sort());
	ext.dispose();
	assert.equal([...pi.handlers.values()].every((list) => list.length === 0), true);
});

test("rejects missing, non-string, and over-bounded identity config", () => {
	assert.equal(validateObservationConfig(undefined).ok, false);
	assert.equal(validateObservationConfig({ worker_id: 42, task_id: "t", execution_generation: "g" }).ok, false);

	const tooLong = "x".repeat(ID_MAX_LENGTH + 1);
	const result = validateObservationConfig({ worker_id: tooLong, task_id: "t", execution_generation: "g" });
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /worker_id/);

	assert.equal(createObservationRecorder({ config: WORKER, sink: null }), null);
	assert.equal(createObservationRecorder({ config: undefined, sink: () => {} }), null);

	const ok = createObservationRecorder({ config: WORKER, sink: () => {} });
	assert.deepEqual(ok.config, WORKER);
	assert.deepEqual(ok.observe("not_observed", {}, {}), { seq: null, delivered: false, pending: false, skipped: true });
});

test("settles thenable sinks truthfully without claiming delivery early", async () => {
	let calls = 0;
	const recorder = createObservationRecorder({
		config: WORKER,
		streamId: "stream-async",
		sink: async () => {
			calls += 1;
		},
	});
	const result = recorder.observe("agent_start", {}, {});
	assert.equal(calls, 1);
	assert.equal(result.delivered, false); // never claimed from Promise creation
	assert.equal(result.pending, true);
	assert.deepEqual(recorder.stats(), { seq: 1, delivered: 0, failed: 0, pending: 1 });
	assert.equal(await result.settled, true);
	assert.deepEqual(recorder.stats(), { seq: 1, delivered: 1, failed: 0, pending: 0 });
});

test("catches rejected thenable sinks with no unhandled rejection", async () => {
	const rejections = [];
	const onRejection = (reason) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		const recorder = createObservationRecorder({
			config: WORKER,
			streamId: "stream-reject",
			sink: async () => {
				throw new Error("offline");
			},
		});
		const result = recorder.observe("agent_start", {}, {});
		assert.equal(result.delivered, false);
		assert.equal(result.pending, true);
		assert.equal(await result.settled, false);
		assert.deepEqual(recorder.stats(), { seq: 1, delivered: 0, failed: 1, pending: 0 });
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(rejections, []);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("register is idempotent per surface and dispose allows clean re-register", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event) });
	assert.equal(h.ext.register(h.pi), false); // already registered by the default export
	await h.pi.emit("session_compact_failed", { reason: "manual" }, h.ctx);
	assert.equal(events.length, 1);

	h.ext.dispose();
	await h.pi.emit("session_compact_failed", { reason: "manual" }, h.ctx);
	assert.equal(events.length, 1); // disposed: no new incidents

	assert.equal(h.ext.register(h.pi), true);
	await h.pi.emit("session_compact_failed", { reason: "manual" }, h.ctx);
	assert.equal(events.length, 2);
	assert.equal(h.ext.register(h.pi), false);
	await h.pi.emit("session_compact_failed", { reason: "manual" }, h.ctx);
	assert.equal(events.length, 3);
});

test("assigns a bounded per-recorder observation_stream_id", async () => {
	const events = [];
	const h = makeHarness({ sink: (event) => events.push(event), streamId: "worker-stream-abc" });
	await h.pi.emit("agent_start", {}, h.ctx);
	assert.equal(events[0].observation_stream_id, "worker-stream-abc");
	assert.equal(h.ext.recorder.streamId, "worker-stream-abc");

	const a = createObservationRecorder({ config: WORKER, sink: () => {} });
	const b = createObservationRecorder({ config: WORKER, sink: () => {} });
	assert.notEqual(a.streamId, b.streamId);
	assert.ok(a.streamId.length <= ID_MAX_LENGTH);
});
