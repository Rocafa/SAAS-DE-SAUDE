import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthModule } from '../src/health/health.module';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde 200 com status ok e nada além disso', async () => {
    const res = await request(app.getHttpServer() as Server).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
