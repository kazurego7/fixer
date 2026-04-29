import type { FastifyInstance } from 'fastify';

export function registerSpaRoutes(app: FastifyInstance): void {
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos/new', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/repos/new/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/chat/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/view', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/files/view/', async (_request, reply) => reply.sendFile('index.html'));
}
