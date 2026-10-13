import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderConnectionBlock, renderInstallPrompt, type ConnectionProject } from '../lib/project-connection';

// Full real Workspace/ConnectionSetup components; only navigation, identity and API transport are synthetic.
test('project UI opens settings, copies identical templates, handles clipboard failure and separates Handoff', { timeout: 60000 }, async () => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/workspace'; createRoot(document.getElementById('root')).render(<Workspace projectId="synthetic-project" />);`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'synthetic-client-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(next\/navigation|next\/link|@clerk\/nextjs)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path === 'next/navigation' ? `export const useRouter=()=>({push:(url)=>location.assign(url)}); export const useSearchParams=()=>new URLSearchParams(location.search);`
          : args.path === 'next/link' ? `import {createElement} from 'react'; export default function Link(props){return createElement('a',props,props.children)}`
          : `export function UserButton(){return null}`, resolveDir: process.cwd() }));
    } }],
  });
  const css = await readFile('app/theme.css', 'utf8');
  let project: ConnectionProject = { id: 'synthetic-project', mode: 'connected', github_repository: 'example/synthetic' };
  const fullProject = () => ({ ...project, name: '합성 온보딩 프로젝트', description: '온보딩 화면 검증용', revision: 1, updated_at: '2026-10-13T06:00:00.000Z', purpose: '', timezone: 'Asia/Seoul' });
  const mutations: string[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'GET') mutations.push(req.method ?? 'unknown');
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else if (url.pathname === '/theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (url.pathname === '/api/workspace') {
      const page = { items: [], next_cursor: null }, view = url.searchParams.get('view');
      const result = view === 'projects' ? { items: [fullProject()], next_cursor: null } : view === 'cursor' ? { revision: 1 } :
        { project: fullProject(), topics: page, pending_activities: page, candidate_work: page, context: page, active_work: page, ready_work: page, blocked_work: page, recent: page };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/theme.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const hasEdge = await access(edge).then(() => true, () => false);
  const browser = await chromium.launch({ headless: true, ...(hasEdge ? { executablePath: edge } : {}) }).catch(async error => {
    await new Promise<void>(done => server.close(() => done())); throw error;
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => {
      if (window.failClipboard) throw new Error('synthetic denial'); window.copied = text;
    } } });`);
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole('button', { name: '연결 설정', exact: true }).click();
    const area = page.getByRole('textbox', { name: 'AGENTS.md 연결 설정', exact: true });
    await area.waitFor(); assert.equal(await area.inputValue(), renderConnectionBlock(project));
    await page.getByRole('button', { name: 'AGENTS.md 내용 복사', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { copied: string }).copied) === renderConnectionBlock(project), true, JSON.stringify({ errors, alerts: await page.getByRole('alert').allTextContents(), buttons: await page.locator('dialog button').allTextContents() }));
    await page.getByRole('button', { name: 'Codex 설치 요청 복사', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { copied: string }).copied), renderInstallPrompt(project));
    await page.getByText('MCP 연결·인증 확인', { exact: true }).click();
    assert((await page.locator('.connection-setup pre').innerText()).includes('codex mcp add'));
    await page.evaluate(() => { (window as unknown as { failClipboard: boolean }).failClipboard = true; });
    await page.getByRole('button', { name: 'AGENTS.md 내용 복사', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.equal(await area.inputValue(), renderConnectionBlock(project));
    const screenshots = resolve('../.local/onboarding-ui'); await mkdir(screenshots, { recursive: true });
    await page.locator('dialog').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: resolve(screenshots, 'connected.png') });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').count(), 0);

    project = { ...project, mode: 'handoff' };
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '연결 설정', exact: true }).click();
    await area.waitFor(); assert.equal(await area.inputValue(), renderConnectionBlock(project));
    assert.equal(await page.getByText('MCP 연결·인증 확인', { exact: true }).count(), 0);
    assert(!(await page.locator('dialog').innerText()).includes('codex mcp add'));
    assert(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: resolve(screenshots, 'handoff-mobile.png') });
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
});
