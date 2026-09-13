import { spawnSync } from 'node:child_process';

function setTerminalEcho(enabled) {
  if (process.platform === 'win32') return;
  const result = spawnSync('stty', [enabled ? 'echo' : '-echo'], {
    stdio: ['inherit', 'ignore', 'ignore'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('stty could not change terminal echo state');
  }
}

/**
 * Read a secret from an interactive terminal without echoing input.
 *
 * Passman still owns the durable credential. This helper only holds the
 * value in memory long enough for the caller to write it to Passman.
 */
export function promptSecret(message) {
  const input = process.stdin;

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Cannot securely prompt for a Jira token: an interactive terminal is required.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    let echoDisabled = false;
    const previousRaw = input.isRaw;

    const restore = () => {
      try {
        input.setRawMode(Boolean(previousRaw));
      } catch {
        // The terminal may already be closing; there is nothing else to do.
      }
      if (echoDisabled) {
        try {
          setTerminalEcho(true);
        } catch {
          // Do not mask the original prompt result with terminal cleanup.
        }
      }
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
    };

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      restore();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          finish(new Error('Jira token prompt cancelled.'));
          return;
        }
        if (char === '\u0004') {
          finish(new Error('Jira token prompt cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char === '\u0015') {
          value = '';
          continue;
        }
        if (char >= ' ' && char !== '\u007f') value += char;
      }
    };

    const onEnd = () => finish(new Error('Jira token prompt cancelled.'));
    const onError = (error) => finish(error);

    input.setEncoding('utf8');
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);

    try {
      // Explicitly disable echo as well as raw mode before displaying the
      // prompt. Bun/Node raw-mode implementations differ in whether they
      // clear the terminal ECHO bit.
      input.setRawMode(true);
      setTerminalEcho(false);
      echoDisabled = true;
      process.stderr.write(message);
      input.resume();
    } catch (error) {
      finish(new Error(`Cannot securely prompt for a Jira token: ${error.message}`));
    }
  });
}
