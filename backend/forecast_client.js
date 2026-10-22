const { spawn } = require('child_process');
const path = require('path');

let worker = null;
let output = '';
let pending = null;

function stopWorker(error) {
  const child = worker;
  worker = null;
  output = '';
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = null;
  }
  if (child && !child.killed) child.kill();
}

function startWorker() {
  if (worker && worker.exitCode === null) return;
  const script = path.join(__dirname, 'forecast_service.py');
  const command = process.env.SSES_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const args = process.env.SSES_PYTHON ? [script] : (process.platform === 'win32' ? ['-3', script] : [script]);
  const child = spawn(command, args, { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  worker = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      if (!pending) continue;
      const request = pending;
      pending = null;
      clearTimeout(request.timer);
      try { request.resolve(JSON.parse(line)); }
      catch { request.reject(new Error('The local forecast worker returned invalid output.')); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', message => console.warn('[Forecast worker]', message.trim().slice(0, 300)));
  child.on('error', error => stopWorker(new Error(`Local Python forecast worker unavailable: ${error.message}`)));
  child.on('close', code => {
    if (worker === child) worker = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Local Python forecast worker stopped (${code ?? 'unknown'}).`));
      pending = null;
    }
  });
}

function predict(readings) {
  startWorker();
  if (!worker || !worker.stdin.writable) return Promise.reject(new Error('Local Python forecast worker is unavailable.'));
  if (pending) return Promise.reject(new Error('A forecast request is already running.'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, timer: setTimeout(() => stopWorker(new Error('Local forecast timed out.')), 15000) };
    worker.stdin.write(JSON.stringify({ readings }) + '\n', error => {
      if (error && pending) stopWorker(new Error('Could not send data to the local forecast worker.'));
    });
  });
}

process.on('exit', () => { if (worker && !worker.killed) worker.kill(); });

module.exports = { predict };
