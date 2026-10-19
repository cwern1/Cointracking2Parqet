import type { OAuthConfig } from '../core/oauth';

export const APP_NAME = 'Cointracking2Parqet';

export const CT_CALLS_PER_HOUR = 20;

export function oauthConfig(): OAuthConfig {
  return {
    clientId: import.meta.env.VITE_PARQET_CLIENT_ID ?? '',
    authorizeUrl: import.meta.env.VITE_PARQET_AUTHORIZE_URL || 'https://connect.parqet.com/oauth2/authorize',
    tokenUrl: '/api/parqet/oauth2/token',
    redirectUri: `${location.origin}/callback`,
    scope: 'portfolio:read portfolio:write',
  };
}
