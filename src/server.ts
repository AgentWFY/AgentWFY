import { fork } from "child_process";
import type { ChildProcess } from 'child_process';
import path from "path";
import electronIsDev from "electron-is-dev";
import log from "electron-log";
import axios from 'axios';

let serverProcess: ChildProcess | null;
let lastPing = Date.now();
let pingInterval: NodeJS.Timeout;

async function isServerRunning(): Promise<boolean> {
  try {
    const response = await axios.post('http://localhost:23578/ping');
    return response.data === 'tradinglog-server';
  } catch (error) {
    return false;
  }
}

export async function startServer(dataDir: string) {
  if (await isServerRunning()) {
    log.info("Standalone server is already running on port 23578");
    return;
  }

  if (serverProcess) {
    throw new Error("Server process exists");
  }

  return new Promise<void>((resolve) => {

    let clientDir;
    if (electronIsDev) {
      clientDir = path.join(__dirname, 'client');
    } else {
      clientDir = path.join(process.resourcesPath, 'app', '.webpack', 'main', 'client');
    }

    const envs = {
      ...process.env,
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      CLIENT_DIR: clientDir
    }

    let serverPath;
    if (electronIsDev) {
      serverPath = path.join(__dirname, 'server', 'index.js');
    } else {
      serverPath = path.join(process.resourcesPath, 'app', '.webpack', 'main', 'server', 'index.js');
    }

    serverProcess = fork(serverPath, [], { env: envs, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

    serverProcess.stdout?.on('data', (data) => {log.info(data.toString())});
    serverProcess.stderr?.on('data', (data) => {log.info(data.toString())});

    serverProcess.on('message', (message) => {
      if (message === 'ready') {
        lastPing = Date.now();
        pingInterval = setInterval(() => {
          if (Date.now() - lastPing > 2000) {
            stopServer();
            startServer(dataDir);
          }
        }, 1000);
        resolve();
      }

      if (message === 'ping') {
        lastPing = Date.now();
        serverProcess.send('pong');
      }
    });
  })
}

export  async function stopServer() {
  if (!serverProcess) return

  return new Promise<void>((resolve) => {
    serverProcess.kill();
    pingInterval.unref();
    serverProcess.on('close', resolve)
    serverProcess = null;
  })
}
