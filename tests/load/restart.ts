/**
 * Restart check: runs the built server as a real process, plays part of a game, then stops
 * the process the way a redeploy does (SIGTERM) and the way a crash does (SIGKILL). After each,
 * it starts the server again and checks that phones get back in with their answers and scores.
 *
 *   npm run build && npm run test:restart
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import type { GuestView, HostView } from '../../shared/protocol.js';

const PORT = 3200;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'restart-check-password';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'trip-party-restart-'));
// Saves happen within about 2 seconds of a change, so a crash after this loses nothing.
const SAVED_WITHIN_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const problems: string[] = [];
let server: ChildProcess | null = null;

function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) problems.push(message);
}

async function startServer(): Promise<void> {
  server = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'restart-check-session-secret' },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 100; tries += 1) {
    if (await fetch(`${URL_BASE}/healthz`).then((response) => response.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error('The server did not start.');
}

async function stopServer(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const running = server!;
  const exited = new Promise((resolve) => running.once('exit', resolve));
  running.kill(signal);
  await exited;
  server = null;
}

async function signIn(): Promise<string> {
  const response = await fetch(`${URL_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

function open(room: string, role: 'guest' | 'host', cookie?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(URL_BASE, {
      auth: { room, role },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: cookie ? { cookie } : undefined,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const ask = <T = any>(socket: Socket, event: string, payload: unknown = {}): Promise<T> =>
  socket.timeout(5000).emitWithAck(event, payload);

interface Phone {
  name: string;
  token: string;
  socket: Socket;
  seq: number;
}

async function main(): Promise<void> {
  await startServer();
  let cookie = await signIn();
  const roomResponse = await fetch(`${URL_BASE}/api/admin/rooms`, { method: 'POST', headers: { cookie } });
  const room = ((await roomResponse.json()) as { id: string }).id;
  let tv = await open(room, 'host', cookie);
  const tvView = async () => (await ask<{ view: HostView }>(tv, 'host:hello')).view;
  const press = async (type: 'next' | 'skipTimer') => ask(tv, 'host:command', { type, screenId: (await tvView()).screenId });

  const phones: Phone[] = [];
  for (const name of ['Aiko', 'Kenji', 'Mei']) {
    const token = randomBytes(32).toString('base64url');
    const socket = await open(room, 'guest');
    const reply = await ask(socket, 'guest:join', { token, name });
    if (reply.status !== 'joined') throw new Error(`${name} couldn't join.`);
    phones.push({ name, token, socket, seq: 0 });
  }
  const viewOf = async (phone: Phone): Promise<GuestView> => (await ask(phone.socket, 'guest:hello', { token: phone.token })).view;

  async function comeBack(): Promise<void> {
    cookie = await signIn().catch(() => cookie);
    tv = await open(room, 'host', cookie);
    for (const phone of phones) {
      phone.socket = await open(room, 'guest');
      const reply = await ask(phone.socket, 'guest:hello', { token: phone.token });
      check(reply.status === 'joined', `${phone.name} got straight back in with the saved token`);
    }
  }

  await press('next'); // Title card
  await press('next'); // First word, writing
  const answers = ['A fish that hums', 'The smell after rain on a temple roof', 'Folding laundry at midnight'];
  for (const [index, phone] of phones.entries()) {
    const view = await viewOf(phone);
    phone.seq += 1;
    await ask(phone.socket, 'guest:answer', { screenId: view.screenId, seq: phone.seq, text: answers[index] });
  }

  console.log('Redeploy (SIGTERM) while everyone is writing');
  await stopServer('SIGTERM');
  await startServer();
  await comeBack();
  for (const [index, phone] of phones.entries()) {
    const screen = (await viewOf(phone)).screen;
    check(screen.kind === 'write' && screen.answer === answers[index], `${phone.name}'s answer is still there`);
  }
  check((await tvView()).players.length === 3, 'the TV still has all three players');

  // Plays on to the reveal, so there are scores to lose.
  await press('skipTimer');
  for (let steps = 0; steps < 20 && (await tvView()).screen.kind === 'show'; steps += 1) await press('skipTimer');
  check((await tvView()).screen.kind === 'vote', 'the round moved on to voting after the restart');
  for (const phone of phones) {
    const view = await viewOf(phone);
    if (view.screen.kind !== 'vote') continue;
    phone.seq += 1;
    await ask(phone.socket, 'guest:vote', { screenId: view.screenId, seq: phone.seq, entryId: view.screen.options[0]!.id });
  }
  await press('skipTimer');
  const totals = new Map<string, number>();
  for (const phone of phones) {
    const screen = (await viewOf(phone)).screen;
    if (screen.kind === 'reveal') totals.set(phone.name, screen.result.total);
  }
  check(totals.size === 3, 'everyone reached the reveal with a total');
  await sleep(SAVED_WITHIN_MS);

  console.log('Crash (SIGKILL) during the reveal, after the last save');
  await stopServer('SIGKILL');
  await startServer();
  await comeBack();
  for (const phone of phones) {
    const screen = (await viewOf(phone)).screen;
    const total = screen.kind === 'reveal' ? screen.result.total : null;
    check(total === totals.get(phone.name), `${phone.name}'s score is intact (${total} of ${totals.get(phone.name)})`);
  }
  check((await press('next')).ok === true, 'the TV can move on to the next screen');
}

main()
  .catch((error: Error) => problems.push(error.message))
  .finally(async () => {
    if (server) await stopServer('SIGTERM');
    rmSync(DATA_DIR, { recursive: true, force: true });
    if (problems.length > 0) {
      console.log(`\nFailed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      process.exit(1);
    }
    console.log('\nPassed.');
    process.exit(0);
  });
