import { blockBanned } from './middleware/blockBanned.js';
import { accountRoute } from './routes/account.js';

export function register(app) {
  app.use(blockBanned);
  app.get('/account', accountRoute);
}
