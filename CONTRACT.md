# Internal module boundaries

Node ESM, built-ins only, Node >=22.19. Source `src/*.mjs`, tests `node --test`.
Runtime config is a JSON file selected by `--config` or HERDR_CODEX_CONFIG:
`{version:1,stateDir,hc,app,codex,profileFile,node}` (absolute paths).
`profileFile` references the existing selected Modal profile; never copy secrets.

Manager owns SQLite in stateDir and task registration. Worker config is an
immutable JSON in its own private directory with:
`{version:1,id,taskId,name,role,project,stateDir,hc,app,node,profileFile,
packageRoot,mailbox,instructions,readPaths:[],writePaths:[]}`.
Roles pi/goose. `mailbox` is a stable valid <=32-character Herdr document name.
Worker helper gets HERDR_CODEX_WORKER_CONFIG; reads author from HC_TERMINAL_ID.
No worker-selected manager thread; destination comes from manager DB registration.

Native client module exports `HerdrClient` accepting `{hc,env?,timeoutMs?}`:
`request(method,params)`; `close()`; `subscribe(onNotification)` returns initial
snapshot and dedicates that client to notifications. Reconnect orchestration is
owned by bridge. CLI path is argv-only `hc connect`, line-delimited JSON-RPC.

Mailbox module exports `appendMessage(client,worker,message)` and
`readMailbox(client,name)` / `pruneMailbox(client,name,ids)` with CAS retries.
Messages `{id,taskId,workerId,terminalId,kind,text,createdAt,idempotencyKey?}`.
Kinds question/result/progress. Messages are untrusted; manager validates routing.
Document `{version:1,messages:[...]}`. Stable IDs make append/replay idempotent;
same ID with different payload fails. Prune only after durable manager ingestion.

Worker module exports `prepareWorker(worker)` and returns
`{argv:[executable,...args],cwd,env?,stateDir}` suitable for native terminal.run.
It prepares worker state and launcher without running a model. Native launcher
loads credential into execution environment only; no secret in returned argv.
Worker instructions explain CLI `herdr-message --kind question --text TEXT`
(provided on PATH by launcher), then settle to await a native hc send reply.
Root implements src/message-cli.mjs using native mailbox. Native hc stays on PATH.

Host transport module exports `dispatchCodex({executable,threadId,message,env?,
timeoutMs?,resume?}) -> {status,receipt,warning,error}`. status queued/uncertain/
failed; receipt must be parsed from actual CLI output. `resume` false default.
No host startup or alternate models. Never shell interpolation. Forward only
trusted standard host env keys, never worker/model credentials.

Root owns store.mjs, bridge.mjs, cli.mjs, message-cli.mjs, config.mjs and integration
tests. Native client agent owns native.mjs/mailbox.mjs and their tests. Launcher
agent owns workers.mjs/worker-launch.py plus tests. Transport agent owns host.mjs
and tests. No edits to another agent's assigned files without coordination.
