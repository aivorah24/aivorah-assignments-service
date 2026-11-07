// /health says which commit is deployed, so "is my fix live?" is answerable
// without the Render dashboard.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const request = require('supertest');

test('health reports the deployed commit (Render sets RENDER_GIT_COMMIT)', async () => {
  process.env.RENDER_GIT_COMMIT = '2b7bc32aa1b2c3d4';
  const app = require('../../index');
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok', service: 'aivorah-assignments-service', commit: '2b7bc32' });
});
