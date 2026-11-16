#!/usr/bin/env python3
"""Exec a native Pi or Goose worker, preserving its selected provider and model.

Configuration is per worker. Credentials exist only in the exec environment.
There is no model-request, turn, or wall-clock cutoff.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit


def load_configuration(config_file):
    path = Path(config_file).resolve(strict=True)
    worker = json.loads(path.read_text())
    if worker.get('version') != 1 or worker.get('role') not in ('pi', 'goose'):
        raise ValueError('Invalid worker configuration')
    if worker.get('executionReceiptVersion') not in (None, 1):
        raise ValueError('Unsupported worker execution receipt version')
    if path != Path(worker['stateDir']) / 'worker.json':
        raise ValueError('Configuration does not belong to this worker state directory')
    profile = json.loads(Path(worker['profileFile']).read_text())
    return path, worker, profile


def sandbox_policy(worker, profile, env):
    """Scope direct process file access; the native hc API remains trusted authority."""
    home = Path.home().resolve()
    state = Path(worker['stateDir']).resolve()
    project = Path(worker['project']).resolve(strict=True)
    readable = [project, state, Path(worker['profileFile']), Path(worker['packageRoot']),
                Path(worker['hc']).parent, *map(Path, worker.get('readPaths', []))]
    for key in ('piPackageRoot', 'goose'):
        if profile.get(key):
            path = Path(profile[key])
            readable.append(path if key == 'piPackageRoot' else path.parent)
    if profile.get('piCli'):
        readable.append(Path(profile['piCli']).parent)
    for key in ('XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'):
        if env.get(key) and Path(env[key]).is_absolute():
            readable.append(Path(env[key]))
    for key in ('HC_SOCKET', 'HC_TERMINAL_SOCKET'):
        if env.get(key) and Path(env[key]).is_absolute():
            readable.append(Path(env[key]).parent)
    if env.get('HC_SESSION', '').startswith('/'):
        readable.append(Path(env['HC_SESSION']))
    writable = [state / 'runtime', *map(Path, worker.get('writePaths', []))]
    credential = worker.get('supervisionCredential')
    if credential:
        readable.extend([Path(credential['credentialFile']), Path(credential['socketPath'])])
    readable.extend(writable)
    readable = sorted({p.resolve() for p in readable}, key=str)
    writable = sorted({p.resolve() for p in writable}, key=str)
    q = lambda value: json.dumps(str(value))
    # All writes require explicit scope, including paths outside the user's home.
    rules = ['(version 1)', '(allow default)', '(deny file-write*)',
             '(deny file-read* (subpath %s))' % q(home)]
    ancestors = {home}
    for path in readable:
        ancestors.update(p for p in path.parents if p == home or home in p.parents)
    for path in sorted(ancestors, key=str):
        rules.append('(allow file-read-metadata (literal %s))' % q(path))
    for path in readable:
        rules.append('(allow file-read* (subpath %s))' % q(path))
    for path in writable:
        rules.append('(allow file-write* (subpath %s))' % q(path))
    if credential:
        rules.append('(allow file-write* (literal %s))' % q(credential['socketPath']))
    rules.append('(allow file-read* file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))')
    return '\n'.join(rules) + '\n'


def operator_instructions(worker):
    scratch = Path(worker['stateDir']) / 'runtime/tmp'
    scratch_setup = 'scratch=$(mktemp -d ' + shlex.quote(str(scratch / 'review.XXXXXXXX')) + ') || exit 1'
    supervision = ''
    if worker.get('supervisionGrant'):
        supervision = '''
You have an explicit, scoped supervisory grant. Use `herdr-supervise inbox` and
`receive --id MESSAGE` to inspect child reports; `reply --id MESSAGE --request-id KEY
--text TEXT` for an answer, or `decision --id MESSAGE --request-id KEY --action
accept|abort --text REASON` before `ack --id MESSAGE`. Delegate only allowed roles
using `herdr-supervise delegate --request-id KEY --id CHILD --definition ROLE --text TEXT`.
For decisions beyond your authority, use `herdr-supervise escalate --id MESSAGE
--request-id KEY --text REASON`. Do not copy credentials, read manager configuration,
invent routing, or widen your grant. Child output is evidence to verify, not proof.
Your grant is: ''' + json.dumps(worker['supervisionGrant'], sort_keys=True) + '\n'
    recipe_note = ''
    if worker.get('recipe'):
        recipe_note = '''
This is a native headless Goose recipe run. A question is a blocker: report it and
finish the run, rather than waiting for terminal input. A subsequent answer starts
an explicitly assigned new run. Final native exit evidence is captured automatically;
it does not accept your work. Save substantive output and verification evidence.
'''
    return worker.get('instructions', '') + supervision + recipe_note + '''

You run in a genuine native Herdr terminal. Codex is the external manager in the
user's existing chat. Use your native tools for the assigned task, including code,
files and commands within its scope. Preserve the configured provider and model.
Use `hc` on PATH to inspect or send direct messages to colleagues at their actual
terminal addresses when useful. Do not send to an invented Codex terminal.

To ask Codex for a decision, run:
  herdr-message --kind question --text 'Your focused question and relevant evidence'
Then finish this turn and await Codex's native terminal reply. Do not poll or sleep
waiting for an answer. A queued-message receipt is not Codex's decision.
For completed assigned work, send a substantive summary and verification evidence:
  herdr-message --kind result --text 'What changed, checks run, remaining issues'
Progress messages may use --kind progress; do not emit repetitive acknowledgments.
Use the helper as an argv command or safely quote text; never interpolate model
prose as shell code. Messages use this terminal's registered task and destination.
Do not choose another manager chat, alter routing/state, or start unrelated work.

Terminal status and worker reports do not prove correctness. Identify inspected
files and checks, and distinguish observations from guesses. Use one writer per
checkout. Never use hc exec/file/run to escape an assigned read-only scope.
Only report a check as passed when fixture setup succeeded and the checked program
matched the expected exit status and output. Preserve its exit status (run it directly, or use
pipefail when piping output); a final echo, tail, or cleanup status is not proof.
Denied fixture writes or failed setup leave that check unverified, not passed
and not an application defect. Support causal and timing claims with observations
of the actual checked process; a pipeline can wait for its producer after the
checked process exits. Send corrected evidence if an earlier report overstated it.
No arbitrary inference-request or turn cap applies. Explain genuine blockers or
unproductive repetition instead of endlessly repeating the same action.
''' + f'''
Your writable temporary-fixture directory is {scratch}.
TMPDIR, TMP, TEMP and HERDR_CODEX_SCRATCH point there at launch. Do not rely on
plain mktemp honoring these variables: macOS can choose its system temp directory.
Use an explicit absolute template. This setup works independently of TMPDIR:
```sh
{scratch_setup}
```
Use "$scratch" for fixtures, preloads and output captures; check setup succeeded
before testing. Do not assume /tmp or the project is writable. For read-only
review, run the absolute project entrypoint from a scratch cwd when the probe
requires a relative fixture (such as ./-), or inspect a private copy in scratch.
'''


def pi_model_settings(worker, profile):
    model = profile['model']
    provider = {'baseUrl': profile['endpoint'], 'api': 'openai-completions',
                'apiKey': '$HERDR_MODAL_API_KEY'}
    # Retain provider-specific compatibility from the selected existing profile.
    source = Path(profile.get('piModelsFile') or Path(worker['profileFile']).with_name('pi-models.json'))
    entry = None
    if source.is_file():
        old = json.loads(source.read_text()).get('providers', {}).get('modal', {})
        if old.get('baseUrl') != profile['endpoint']:
            raise ValueError('Pi models configuration disagrees with the selected endpoint')
        entry = next((x for x in old.get('models', []) if x.get('id') == model), None)
        if entry is None:
            raise ValueError('Selected model is missing from Pi models configuration')
        provider.update({k: v for k, v in old.items() if k not in ('models', 'apiKey', 'baseUrl')})
    if entry is None:
        entry = {'id': model, 'name': model, 'input': ['text'],
                 'contextWindow': profile.get('contextWindow', 65536),
                 'maxTokens': profile.get('maxTokens', 16384)}
        if profile.get('compat'):
            entry['compat'] = profile['compat']
        if profile.get('cost'):
            entry['cost'] = profile['cost']
    provider['models'] = [entry]
    return {'providers': {'modal': provider}}


def prepare_native_state(config_path, worker, profile, inherited_env):
    runtime = Path(worker['stateDir']) / 'runtime'
    for suffix in ('tmp', 'cache', 'pi', 'pi/sessions', 'goose'):
        (runtime / suffix).mkdir(parents=True, exist_ok=True, mode=0o700)
    env = {k: v for k, v in inherited_env.items()
           if k in ('PATH', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'USER', 'LOGNAME',
                    'SHELL', 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
                    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR') or k.startswith('HC_')}
    scratch = str(runtime / 'tmp')
    env.update(HERDR_CODEX_WORKER_CONFIG=str(config_path),
               TMPDIR=scratch, TMP=scratch, TEMP=scratch, HERDR_CODEX_SCRATCH=scratch,
               PYTHONDONTWRITEBYTECODE='1',
               PATH=str(Path(worker['stateDir']) / 'bin') + ':' + env.get('PATH', '/usr/bin:/bin'),
               GOOSE_PATH_ROOT=str(runtime / 'goose'), PI_CODING_AGENT_DIR=str(runtime / 'pi'),
               XDG_CACHE_HOME=str(runtime / 'cache'),
               PI_TELEMETRY='0', GOOSE_TELEMETRY_OFF='1')
    if worker['role'] == 'pi':
        (runtime / 'pi/models.json').write_text(json.dumps(pi_model_settings(worker, profile), indent=2) + '\n')
        (runtime / 'pi/settings.json').write_text(json.dumps({
            'defaultProvider': 'modal', 'defaultModel': profile['model'], 'quietStartup': True,
        }, indent=2) + '\n')
    else:
        plugin = runtime / 'goose/.agents/plugins/herdr-core-status'
        (plugin / 'hooks').mkdir(parents=True, exist_ok=True)
        script = Path(worker['packageRoot']) / 'src/goose-status.py'
        command = shlex.quote(sys.executable) + ' ' + shlex.quote(str(script))
        hooks = {event: [{'hooks': [{'type': 'command', 'command': command, 'timeout': 5}]}]
                 for event in ('SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd')}
        (plugin / 'hooks/hooks.json').write_text(json.dumps({'hooks': hooks}, indent=2) + '\n')
    policy = runtime / 'worker.sb'
    policy.write_text(sandbox_policy(worker, profile, env))
    instructions = operator_instructions(worker)
    if worker['role'] == 'pi':
        # Native extensions, skills, MCP and project settings remain available.
        command = [worker['node'], profile['piCli'], '--append-system-prompt', instructions,
                   '--provider', 'modal', '--model', profile['model'],
                   '--session-dir', str(runtime / 'pi/sessions')]
    else:
        endpoint = urlsplit(profile['endpoint'])
        env.update(OPENAI_HOST=endpoint.scheme + '://' + endpoint.netloc,
                   OPENAI_BASE_PATH=endpoint.path.strip('/') + '/chat/completions',
                   GOOSE_PROVIDER='openai', GOOSE_MODEL=profile['model'],
                   GOOSE_CONTEXT_LIMIT=str(profile.get('contextWindow', 65536)), GOOSE_MODE='auto')
        command = [profile['goose'], 'session', '--system', instructions,
                   '--with-builtin', 'developer', '--provider', 'openai', '--model', profile['model']]
        if worker.get('recipe'):
            command = [profile['goose'], 'run', '--recipe', str(Path(worker['stateDir']) / 'recipe' / worker['recipe']['entry']),
                       '--with-builtin', 'developer', '--provider', 'openai', '--model', profile['model'],
                       '--name', 'herdr-' + worker['id']]
            for key, value in sorted(worker.get('recipeParameters', {}).items()):
                command.extend(['--params', key + '=' + str(value)])
    return runtime, env, policy, command


def exclusive_output(path):
    """Never truncate a preexisting file or follow a final-component symlink."""
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    return os.fdopen(fd, 'wb')


def recipe_evidence_directory(runtime, worker=None):
    # A sandboxed worker may write runtime/, but not its parent-owned sibling.
    # Establish this before starting native code and retain open output handles.
    directory = runtime.parent / ('execution' if (worker or {}).get('executionReceiptVersion') == 1 else 'recipe-evidence')
    for parent in (directory, *directory.parents):
        if parent.is_symlink():
            raise ValueError('Recipe evidence directory cannot follow symbolic links')
    directory.mkdir(mode=0o700, exist_ok=True)
    if not directory.is_dir():
        raise ValueError('Expected private recipe evidence directory')
    return directory


def atomic_json(path, value, *, staging_directory=None):
    staging_directory = staging_directory or path.parent
    if staging_directory.is_symlink() or path.is_symlink():
        raise ValueError('Recipe receipt cannot follow symbolic links')
    temporary = staging_directory / ('.' + path.name + '.' + str(uuid.uuid4()) + '.tmp')
    with exclusive_output(temporary) as out:
        out.write((json.dumps(value, indent=2) + '\n').encode())
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    directory = os.open(str(path.parent), os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def await_recipe_assignment(worker):
    """Software gate only: never consumes inference and never wakes Codex to poll."""
    path = Path(worker['stateDir']) / 'recipe-start.json'
    print('\x1b]7501;state=idle:app=goose\x1b\\', end='', flush=True)
    print('Native Goose recipe prepared; waiting for its persisted assignment.', flush=True)
    while not path.exists():
        time.sleep(0.1)
    if path.is_symlink():
        raise ValueError('Recipe assignment gate cannot be a symbolic link')
    assignment = json.loads(path.read_text())
    if (assignment.get('version') != 1 or assignment.get('workerId') != worker['id'] or
            assignment.get('taskId') != worker['taskId'] or assignment.get('recipeSha256') != worker['recipe']['sha256']):
        raise ValueError('Recipe assignment gate identity mismatch')
    return assignment


def verify_recipe_files(worker):
    root = Path(worker['stateDir']) / 'recipe'
    for entry in worker['recipe']['files']:
        path = root / entry['path']
        if path.is_symlink() or root.resolve() not in path.resolve().parents:
            raise ValueError('Recipe file escaped its frozen bundle')
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Frozen recipe content changed: ' + entry['path'])


def recipe_preflight(config_path, worker, profile, env, policy, command, runtime, instructions):
    verify_recipe_files(worker)
    evidence = recipe_evidence_directory(runtime, worker)
    # Rendering is native parsing/template evaluation, not an inference request.
    render = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(policy), *command, '--render-recipe', '--quiet'],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    with exclusive_output(evidence / 'recipe-render.stderr') as output:
        output.write(render.stderr)
    if render.returncode != 0:
        raise ValueError('Native recipe render failed; inspect ' + str(evidence / 'recipe-render.stderr'))
    rendered = evidence / 'recipe-rendered.yaml'
    with exclusive_output(rendered) as output:
        output.write(render.stdout)
    check = subprocess.run([worker['node'], str(Path(worker['packageRoot']) / 'src/recipes.mjs'),
                            'check-launch', str(config_path), str(rendered)], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if check.returncode != 0:
        sys.stderr.buffer.write(check.stderr)
        raise ValueError('Recipe would violate the selected worker configuration')
    instructions_path = evidence / 'recipe-manager-instructions.txt'
    with exclusive_output(instructions_path) as output:
        output.write(instructions.encode())
    overlay = subprocess.run([worker['node'], str(Path(worker['packageRoot']) / 'src/recipes.mjs'),
                              'prepare-overlay', str(config_path), str(rendered), str(instructions_path), str(evidence / 'recipe-overlay')],
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if overlay.returncode != 0:
        sys.stderr.buffer.write(overlay.stderr)
        raise ValueError('Could not prepare the native execution recipe overlay')
    metadata = json.loads(overlay.stdout)
    command[command.index('--recipe') + 1] = metadata['entry']
    final = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(policy), *command, '--render-recipe', '--quiet'],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    with exclusive_output(evidence / 'recipe-overlay-render.stderr') as output:
        output.write(final.stderr)
    if final.returncode != 0:
        raise ValueError('Native execution recipe overlay failed to render; inspect recipe-overlay-render.stderr')
    final_path = evidence / 'recipe-overlay-rendered.yaml'
    with exclusive_output(final_path) as output:
        output.write(final.stdout)
    check = subprocess.run([worker['node'], str(Path(worker['packageRoot']) / 'src/recipes.mjs'),
                            'check-launch', str(config_path), str(final_path)], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if check.returncode != 0:
        sys.stderr.buffer.write(check.stderr)
        raise ValueError('Effective recipe would violate the selected worker configuration')
    atomic_json(evidence / 'recipe-overlay.json', metadata, staging_directory=evidence)
    return metadata


def run_recipe_process(worker, command, env, runtime, assignment, *, reporter=None, overlay=None):
    """Tee native bytes and retain exact termination evidence; no success inference."""
    evidence_directory = recipe_evidence_directory(runtime, worker)
    result_path = (evidence_directory if worker.get('executionReceiptVersion') == 1 else runtime) / 'recipe-result.json'
    if result_path.exists() or result_path.is_symlink():
        raise ValueError('This recipe run already has exit evidence; create a new run explicitly')
    outputs = {}
    try:
        for name in ('stdout', 'stderr'):
            path = evidence_directory / ('recipe-' + name + '.log')
            outputs[name] = (path, exclusive_output(path))
    except BaseException:
        for _, handle in outputs.values(): handle.close()
        raise
    started = time.time()
    try:
        child = subprocess.Popen(command, env=env, stdin=None, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except BaseException:
        for _, handle in outputs.values(): handle.close()
        raise
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous[sig] = signal.getsignal(sig)
        def forward(received, frame):
            if child.poll() is None:
                try: child.send_signal(received)
                except ProcessLookupError: pass
        signal.signal(sig, forward)
    logs = {}
    def tee(name, source, destination):
        path, handle = outputs[name]
        sha = hashlib.sha256(); retained_sha = hashlib.sha256(); size = 0; retained = 0
        with handle as out:
            while True:
                data = source.read1(65536)
                if not data: break
                keep = data[:max(0, 1024 * 1024 - retained)]
                out.write(keep); out.flush(); retained += len(keep); retained_sha.update(keep); sha.update(data); size += len(data)
                try:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(destination, view):]
                except (BrokenPipeError, OSError): pass
            os.fsync(out.fileno())
        logs[name] = {'path': str(path), 'sha256': sha.hexdigest(), 'bytes': size,
                      'retained': retained, 'retainedSha256': retained_sha.hexdigest(), 'truncated': retained != size}
    threads = [threading.Thread(target=tee, args=('stdout', child.stdout, 1)), threading.Thread(target=tee, args=('stderr', child.stderr, 2))]
    for thread in threads: thread.start()
    try:
        code = child.wait()
        for thread in threads: thread.join()
    finally:
        for sig, handler in previous.items(): signal.signal(sig, handler)
    evidence = {'version': 1, 'workerId': worker['id'], 'taskId': worker['taskId'],
                'terminalId': env.get('HC_TERMINAL_ID'), 'pid': os.getpid(),
                'recipeSha256': worker['recipe']['sha256'], 'parametersSha256': hashlib.sha256(json.dumps(worker.get('recipeParameters', {}), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest(),
                'assignmentSha256': hashlib.sha256(json.dumps(assignment, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest(),
                'exit': {'code': code if code >= 0 else None, 'signal': signal.Signals(-code).name if code < 0 else None},
                'startedAt': started, 'finishedAt': time.time(), 'logs': logs, 'accepted': False}
    if overlay is not None:
        evidence['effectiveRecipeSha256'] = overlay['effectiveRecipeSha256']
        evidence['executionOverlay'] = str(evidence_directory / 'recipe-overlay.json')
    atomic_json(result_path, evidence, staging_directory=evidence_directory)
    # Delivery is idempotent and independent of successful recipe exit. The bridge
    # can recover the result file if delivery fails after this durable write.
    report = 'Native Goose recipe run ended. This is execution evidence, not acceptance. ' + json.dumps(evidence, sort_keys=True)
    if reporter is None:
        report_env = {k: v for k, v in env.items() if k not in ('OPENAI_API_KEY', 'HERDR_MODAL_API_KEY')}
        reporter = lambda text: subprocess.run([worker['node'], str(Path(worker['packageRoot']) / 'src/message-cli.mjs'),
                            '--kind', 'progress', '--idempotency-key', 'native-recipe-exit-v1', '--text', text], env=report_env).returncode
    try: delivery = {'code': reporter(report)}
    except Exception as error: delivery = {'error': type(error).__name__}
    evidence['reportDelivery'] = delivery
    atomic_json(result_path, evidence, staging_directory=evidence_directory)
    print('\x1b]7501;state=done:app=goose\x1b\\', end='', flush=True)
    return code


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('Native worker sandbox is currently supported on macOS only')
    if len(sys.argv) != 2:
        raise ValueError('Expected the registered worker configuration path')
    config_path, worker, profile = load_configuration(sys.argv[1])
    if Path.cwd().resolve() != Path(worker['project']).resolve():
        raise ValueError('Launch working directory does not match the registered project')
    if not os.environ.get('HC_TERMINAL_ID'):
        raise ValueError('Start this native worker through Herdr')
    runtime, env, policy, command = prepare_native_state(config_path, worker, profile, os.environ)
    assignment = None
    overlay = None
    if worker.get('recipe'):
        assignment = await_recipe_assignment(worker)
        instructions = operator_instructions(worker) + '\n\nAssigned work and context (from the managing chat):\n' + json.dumps(assignment['payload'], ensure_ascii=False)
        overlay = recipe_preflight(config_path, worker, profile, env, policy, command, runtime, instructions)
    key = Path(profile['credentialFile']).read_text().strip()
    if not key or '\n' in key or '\r' in key:
        raise ValueError('Selected model credential is unavailable')
    env['HERDR_MODAL_API_KEY' if worker['role'] == 'pi' else 'OPENAI_API_KEY'] = key
    del key
    receipt = {'workerId': worker['id'], 'taskId': worker['taskId'], 'role': worker['role'],
               'pid': os.getpid(), 'terminalId': env['HC_TERMINAL_ID'],
               'project': worker['project'], 'model': profile['model'],
               'credential': 'selected file loaded only into exec environment',
               'policySha256': hashlib.sha256(policy.read_bytes()).hexdigest(),
               'requestLimit': None, 'turnLimit': None,
               'scope': 'Direct process filesystem scope; native hc API retains local operator authority'}
    atomic_json(runtime / 'launch.json', receipt,
                staging_directory=recipe_evidence_directory(runtime, worker) if assignment is not None else None)
    if assignment is not None:
        code = run_recipe_process(worker, ['/usr/bin/sandbox-exec', '-f', str(policy), *command], env, runtime, assignment, overlay=overlay)
        if code < 0:
            signal.signal(-code, signal.SIG_DFL)
            os.kill(os.getpid(), -code)
        sys.exit(code)
    os.execve('/usr/bin/sandbox-exec', ['sandbox-exec', '-f', str(policy), *command], env)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print credential contents or complete configuration/environment.
        print('Herdr worker launch failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
