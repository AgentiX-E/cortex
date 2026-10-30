/**
 * Static server for the browser suite: the built package, the sqlite-wasm assets, and one page.
 *
 * ## The route that is not obvious
 *
 * `/sqlite3-*` is mirrored at the origin root because `@sqlite.org/sqlite-wasm` resolves its async
 * proxy worker against the *document* URL rather than against the module URL. Serving the assets
 * only under `/vendor/` produces a 404 that surfaces as "the VFS never initialises", pointing at the
 * database code rather than at the routing. This was learned the direct way while building the
 * proof of concept, and the route is kept here so the lesson does not have to be relearned.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const VENDOR = join(PACKAGE, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
};

/**
 * A directory mounted at a prefix, for a suite that has to serve files it generated at run time.
 *
 * The bundle probe writes an esbuild output into a temporary directory and serves it from
 * `/bundle/`, because the point of that suite is what a consumer's build produces -- serving
 * `dist/` instead would test the sources it came from and pass while the bundle is broken.
 */
function mountFor(pathname, mounts) {
  return mounts.find((mount) => pathname.startsWith(mount.prefix));
}

export function serveDist(port = 0, extraMounts = []) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let file;

    if (url.pathname === '/' || url.pathname === '/page.html') {
      file = join(HERE, 'page.html');
    } else if (url.pathname === '/bundle-page.html') {
      // The bundle probe's page: the same origin, a different module graph.
      file = join(HERE, 'bundle-page.html');
    } else if (mountFor(url.pathname, extraMounts) !== undefined) {
      const mount = mountFor(url.pathname, extraMounts);
      const name = normalize(url.pathname.slice(mount.prefix.length)).replace(
        /^([.][.][/\\])+/,
        '',
      );
      file = join(mount.dir, name);
    } else if (url.pathname.startsWith('/dist/')) {
      file = join(PACKAGE, normalize(url.pathname));
    } else if (url.pathname.startsWith('/vendor/')) {
      const name = normalize(url.pathname.slice('/vendor/'.length)).replace(/^(\.\.[/\\])+/, '');
      file = join(VENDOR, name);
    } else if (url.pathname.startsWith('/sqlite3-')) {
      file = join(VENDOR, url.pathname.slice(1));
    } else if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }

    if (file === undefined) {
      response.writeHead(404).end('not found');
      return;
    }

    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  return new Promise((resolveStarted) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolveStarted({ server, port: address.port, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}
