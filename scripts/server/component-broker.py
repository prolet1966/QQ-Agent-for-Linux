#!/usr/bin/python3
"""One socket-activated request; only fixed component units may be controlled."""
import json
import subprocess
import sys

UNITS = {
    'snow': 'qq-agent-snowluma.service',
    'qq': 'qq-agent-qq.service',
    'desktop': 'qq-agent-desktop.service',
}

def main():
    try:
        packet = sys.stdin.buffer.readline(257)
        if len(packet) > 256 or not packet.endswith(b'\n'):
            raise ValueError('invalid component request size')
        request = json.loads(packet)
        if not isinstance(request, dict) or set(request) != {'kind', 'action'}:
            raise ValueError('invalid component request fields')
        kind, action = request['kind'], request['action']
        if not isinstance(kind, str) or kind not in UNITS or action not in ['start', 'stop', 'restart']:
            raise ValueError('unsupported component action')
        result = subprocess.run(['/usr/bin/systemctl', '--no-ask-password', action, UNITS[kind]],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, text=True, timeout=25, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr[:500] or 'component service action failed')
        response = {'ok': True}
    except (ValueError, TypeError, RuntimeError, subprocess.TimeoutExpired, OSError):
        response = {'ok': False, 'error': '组件管理失败，请检查固定服务及管理员日志'}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    return 0 if response['ok'] else 1

if __name__ == '__main__':
    sys.exit(main())
