import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express = require('express');
import {
  buildSidebarMarkdown,
  createDocsSiteRouter,
  type DocsSiteCredentials,
} from './docs-site.router';

describe('docs site', () => {
  let rootDirectory: string;
  let server: Server | undefined;

  beforeEach(() => {
    rootDirectory = mkdtempSync(join(tmpdir(), 'spreadsheet-docs-'));
    mkdirSync(join(rootDirectory, 'docs'));
    writeFileSync(join(rootDirectory, 'README.md'), '# Spreadsheet API\n');
    writeFileSync(join(rootDirectory, 'docs', 'funcional.md'), '# Guía\n');
    writeFileSync(
      join(rootDirectory, 'docs', 'operacion.md'),
      '# Operación\n\nEl servidor está en /opt/spreadsheet.api\n',
    );
    // Things that live next to the docs and must never be served.
    writeFileSync(
      join(rootDirectory, '.env'),
      'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=x\n',
    );
    writeFileSync(join(rootDirectory, 'docs', 'notas-internas.md'), 'secreto');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server = undefined;
    rmSync(rootDirectory, { recursive: true, force: true });
  });

  async function startSite(
    credentials?: DocsSiteCredentials,
  ): Promise<(path: string, auth?: DocsSiteCredentials) => Promise<Response>> {
    const app = express();
    app.use(
      '/docs',
      createDocsSiteRouter({ basePath: '/docs', rootDirectory, credentials }),
    );

    const listening = app.listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', resolve));
    const { port } = listening.address() as AddressInfo;

    return (path, auth) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers:
          auth === undefined
            ? {}
            : {
                authorization: `Basic ${Buffer.from(
                  `${auth.username}:${auth.password}`,
                ).toString('base64')}`,
              },
      });
  }

  describe('open, without credentials', () => {
    it('serves the page shell pointing at its own content path', async () => {
      const get = await startSite();

      const response = await get('/docs/');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('"/docs/content/"');
    });

    it('serves the README as the home page and the docs under their repository path', async () => {
      const get = await startSite();

      const home = await get('/docs/content/README.md');
      const guide = await get('/docs/content/docs/funcional.md');

      expect(await home.text()).toBe('# Spreadsheet API\n');
      expect(await guide.text()).toBe('# Guía\n');
      expect(guide.headers.get('content-type')).toContain('text/markdown');
      // A git pull has to be enough to publish a text change.
      expect(guide.headers.get('cache-control')).toBe('no-cache');
    });

    it('does not publish the page about the server, in the sidebar or by URL', async () => {
      const get = await startSite();

      const sidebar = await (await get('/docs/content/_sidebar.md')).text();
      const page = await get('/docs/content/docs/operacion.md');
      const pageText = await page.text();

      expect(sidebar).not.toContain('operacion');
      expect(page.status).toBe(200);
      expect(pageText).toContain('no está publicada');
      expect(pageText).not.toContain('/opt/spreadsheet.api');
    });

    it('only serves the files it lists, whatever else sits in the repository', async () => {
      const get = await startSite();

      const unlisted = await get('/docs/content/docs/notas-internas.md');
      const traversal = await get('/docs/content/docs/..%2F.env');
      const env = await get('/docs/content/.env');

      expect(unlisted.status).toBe(404);
      expect(traversal.status).toBe(404);
      expect(env.status).toBe(404);
    });
  });

  describe('behind credentials', () => {
    const credentials = { username: 'tlq', password: 'una-clave' };

    it('asks for them on every route', async () => {
      const get = await startSite(credentials);

      for (const path of [
        '/docs/',
        '/docs/content/README.md',
        '/docs/content/_sidebar.md',
        '/docs/content/docs/operacion.md',
      ]) {
        const response = await get(path);

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Basic');
      }
    });

    it('rejects a wrong password', async () => {
      const get = await startSite(credentials);

      const response = await get('/docs/content/README.md', {
        username: 'tlq',
        password: 'otra-clave',
      });

      expect(response.status).toBe(401);
    });

    it('publishes every page, the one about the server included', async () => {
      const get = await startSite(credentials);

      const sidebar = await (
        await get('/docs/content/_sidebar.md', credentials)
      ).text();
      const page = await (
        await get('/docs/content/docs/operacion.md', credentials)
      ).text();

      expect(sidebar).toContain('(/docs/operacion.md)');
      expect(page).toContain('/opt/spreadsheet.api');
    });
  });

  it('groups the sidebar by section, in order', () => {
    expect(buildSidebarMarkdown(true)).toBe(
      [
        '- **Inicio**',
        '  - [Spreadsheet API](/)',
        '- **Pedidos y planillas**',
        '  - [Guía funcional](/docs/funcional.md)',
        '  - [Errores](/docs/errores.md)',
        '- **API**',
        '  - [Referencia de la API](/docs/api.md)',
        '- **Técnico**',
        '  - [Arquitectura y configuración](/docs/tecnico.md)',
        '  - [Operación](/docs/operacion.md)',
        '',
      ].join('\n'),
    );
  });
});
