#!/usr/bin/env python3
"""Publish native Goose lifecycle status without inspecting assistant prose."""
import json
import os
import sys


def sequence(event):
    states = {'SessionStart': 'idle', 'UserPromptSubmit': 'working',
              'Stop': 'done', 'SessionEnd': 'clear'}
    return '\x1b]7501;state=' + states[event] + ':app=goose\x1b\\'


def main():
    data = json.loads(sys.stdin.buffer.read(65537))
    if not os.environ.get('HC_TERMINAL_ID'):
        raise ValueError('No Herdr terminal identity')
    # Hook stdout is captured by Goose; the controlling TTY is the real stream.
    fd = os.open('/dev/tty', os.O_WRONLY | os.O_NOCTTY)
    try:
        os.write(fd, sequence(data['event']).encode())
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
