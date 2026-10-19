import { startFakeUpstream } from './fakeUpstream';

export default async function globalSetup() {
  const server = await startFakeUpstream();
  return async () => {
    await new Promise<void>((r) => server.close(() => r()));
  };
}
