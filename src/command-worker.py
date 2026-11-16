#!/usr/bin/env python3
"""A single frozen Desk command in a native terminal; no model or shell expansion."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


def main():
    config_path = Path(sys.argv[1]).resolve(strict=True)
    worker = json.loads(config_path.read_text())
    state = Path(worker['stateDir'])
    if sys.platform != 'darwin' or config_path != state / 'worker.json':
        raise ValueError('Expected registered macOS command worker')
    if worker.get('executionReceiptVersion') not in (None, 1):
        raise ValueError('Unsupported worker execution receipt version')
    if Path.cwd().resolve() != Path(worker['project']).resolve() or not os.environ.get('HC_TERMINAL_ID'):
        raise ValueError('Native terminal/project binding missing')
    runtime = state / 'runtime'
    runtime.mkdir(exist_ok=True)
    scratch = runtime / 'tmp'
    scratch.mkdir(exist_ok=True)
    print('\x1b]7501;state=idle:app=desk-command\x1b\\', end='', flush=True)
    gate = state / 'command-start.json'
    while not gate.exists():
        time.sleep(.05)  # Local start gate; no Codex/model activity.
    request = json.loads(gate.read_text())
    if request['fingerprint'] != worker['command']['fingerprint']:
        raise ValueError('Command start identity mismatch')
    print('\x1b]7501;state=working:app=desk-command\x1b\\', end='', flush=True)
    spec = importlib.util.spec_from_file_location('worker_policy', Path(worker['packageRoot']) / 'src/worker-launch.py')
    policy_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy_module)
    profile = json.loads(Path(worker['profileFile']).read_text())
    env = {k: v for k, v in os.environ.items() if k in ('HOME', 'USER', 'LOGNAME', 'PATH', 'TERM', 'LANG') or k.startswith('HC_')}
    env.update(TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch), PYTHONDONTWRITEBYTECODE='1')
    policy = runtime / 'command.sb'
    policy.write_text(policy_module.sandbox_policy(worker, profile, env))
    started = time.time()
    command = worker['command']
    argv = command['argv']
    if not isinstance(argv, list) or not argv or any(not isinstance(a, str) or '\0' in a for a in argv):
        raise ValueError('Expected explicit argv')
    execution = policy_module.recipe_evidence_directory(runtime, worker)
    logs = {name: {'path': str(execution / ('command-' + name + '.log')), 'bytes': 0, 'retained': 0, 'hash': hashlib.sha256(), 'retainedHash': hashlib.sha256()} for name in ('stdout', 'stderr')}
    handles = {}
    try:
        for name, record in logs.items():
            handles[name] = policy_module.exclusive_output(Path(record['path']))
        child = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(policy), *argv], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except BaseException:
        for handle in handles.values(): handle.close()
        raise
    selector = selectors.DefaultSelector()
    for name, pipe, display in [('stdout', child.stdout, sys.stdout.buffer), ('stderr', child.stderr, sys.stderr.buffer)]:
        selector.register(pipe, selectors.EVENT_READ, (name, display))
    try:
        while selector.get_map():
            for key, _ in selector.select():
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name, display = key.data
                record = logs[name]
                record['bytes'] += len(chunk)
                record['hash'].update(chunk)
                retain = chunk[:max(0, 1024 * 1024 - record['retained'])]
                handles[name].write(retain)
                record['retained'] += len(retain)
                record['retainedHash'].update(retain)
                display.write(chunk)
                display.flush()
        code = child.wait()
    finally:
        selector.close()
        for f in handles.values():
            f.flush()
            os.fsync(f.fileno())
            f.close()
    for record in logs.values():
        record['sha256'] = record.pop('hash').hexdigest()
        record['retainedSha256'] = record.pop('retainedHash').hexdigest()
        record['truncated'] = record['bytes'] != record['retained']
    receipt_directory = execution if worker.get('executionReceiptVersion') == 1 else runtime
    policy_module.atomic_json(receipt_directory / 'command-result.json', {'version': 1, 'workerId': worker['id'], 'taskId': worker['taskId'],
        'terminalId': os.environ['HC_TERMINAL_ID'], 'pid': os.getpid(), 'fingerprint': command['fingerprint'],
        'exitCode': code if code >= 0 else None, 'signal': -code if code < 0 else None,
        'startedAt': started, 'finishedAt': time.time(), 'logs': logs, 'modelCalls': 0}, staging_directory=execution)
    print('\x1b]7501;state=done:app=desk-command\x1b\\', end='', flush=True)
    return code if code >= 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Desk command failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
