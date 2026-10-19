import { handleRelay, type RelayEnv } from '../_lib/relay';

export const onRequest: PagesFunction<RelayEnv> = (context) => handleRelay(context.request, context.env);
