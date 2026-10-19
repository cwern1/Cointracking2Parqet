import { handleRelay } from '../_lib/relay.js';
export const onRequest = (context) => handleRelay(context.request, context.env);
