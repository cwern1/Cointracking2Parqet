import { defineConfig, devices } from '@playwright/test';

const UPSTREAM = 'http://localhost:9911';
const PORT = 8790;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Real relay code in the real Workers runtime, pointed at the fake upstream.
    command: [
      `VITE_PARQET_CLIENT_ID=test-client VITE_PARQET_AUTHORIZE_URL=${UPSTREAM}/parqet/oauth2/authorize npx vite build --outDir dist-e2e --emptyOutDir`,
      `npx wrangler pages dev dist-e2e --port ${PORT} --binding CT_UPSTREAM=${UPSTREAM}/ct --binding PARQET_UPSTREAM=${UPSTREAM}/parqet`,
    ].join(' && '),
    url: `http://localhost:${PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
